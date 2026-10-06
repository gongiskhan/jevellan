import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { isAbsolute } from 'node:path';
import { isatty } from 'node:tty';
import { z } from 'zod';
import { CLAUDE_FLAG_SETTINGS, Homes, ThreadAttachViewSchema, ThreadDetachViewSchema, minimalEnvironment, runOwnedCommand } from '@jevellan/core';
import { LocalRequestError, localRequest } from './local-request.js';
import { findExecutable } from './toolchain.js';

export type ThreadCommandOptions = { homes?: Homes; fetcher?: typeof fetch; env?: NodeJS.ProcessEnv };
type AttachView = z.infer<typeof ThreadAttachViewSchema>;
type Launch = { executable: string; args: string[]; env: Record<string, string>; cwd: string; label: string };

// The command's own sentences. The daemon's refusals (a thread that is working, on another device, without a session) are printed as
// the daemon words them, so they live in one place.
const UNREACHABLE = 'Jevellan could not be reached on this device. Check that it is running, then run the command again.';
const UNANSWERED = 'Jevellan did not answer this command.';
const TOO_LARGE = 'The answer from Jevellan was too large.';
const UNUSABLE = 'The answer from Jevellan could not be used.';
const BACK = 'The thread is back in Jevellan.';
const BACK_ADOPTED = 'The thread is back in Jevellan and continues from the session in this terminal.';
const LABELS: Record<AttachView['runtime'], string> = { claude: 'Claude Code', codex: 'Codex' };
const HOME_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** D47: the thread stays attached until a detach reaches the daemon. */
export const staysAttached = (threadId: string): string => `The thread stays attached. Run jevellan thread detach ${threadId} when Jevellan is running.`;
const sentence = (error: unknown) => error instanceof Error && error.message ? error.message : UNANSWERED;

/**
 * One local control request about a thread: the daemon's JSON answer (the caller parses it, so a 200 is always known to have taken
 * effect), or the sentence to print (`refused`: the daemon refused in its own words).
 */
async function call(homes: Homes, options: ThreadCommandOptions, threadId: string, action: 'attach' | 'detach', body: unknown): Promise<{ ok: true; value: unknown } | { ok: false; refused: boolean; message: string }> {
  try {
    return { ok: true, value: await localRequest(homes, `/api/local/threads/${threadId}/${action}`, body, z.unknown(),
      { daemonErrors: true, unanswered: UNANSWERED, tooLarge: TOO_LARGE, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }) };
  } catch (error) {
    if (error instanceof LocalRequestError) return { ok: false, refused: true, message: error.message };
    return { ok: false, refused: false, message: error instanceof Error && [UNANSWERED, TOO_LARGE].includes(error.message) ? error.message : UNREACHABLE };
  }
}
/** The detach answer's last line: a 200 always handed the thread back, whether or not this version can read the rest. */
const back = (answer: unknown) => ThreadDetachViewSchema.safeParse(answer).data?.adopted ? BACK_ADOPTED : BACK;

/** Whether the installed `claude` takes an effort flag: its `--help` lists `--effort` (brief phase 7: probed once per attach). */
export async function claudeTakesEffort(executable: string, cwd: string, env: Record<string, string>): Promise<boolean> {
  try { const help = await runOwnedCommand(executable, ['--help'], { cwd, env, timeoutMs: 15_000, redactOutput: false }); return help.code === 0 && /(?:^|\s)--effort\b/mu.test(help.stdout); }
  catch { return false; }
}

/**
 * The native command for an attach answer (brief phase 7): `claude --resume <id> --model <model>` (with `--effort` when the installed
 * CLI takes it, and the flag settings that keep the account home's transcripts past the CLI's retention, P8 review R-T1) or
 * `codex resume <id> -m <model> -c model_reasoning_effort="<effort>"`, in the thread's folder, with the account home and authentication
 * variables merged into a minimal environment. Secrets stay in the environment, never in the arguments.
 */
async function prepare(answer: unknown, base: NodeJS.ProcessEnv): Promise<Launch | string> {
  const parsed = ThreadAttachViewSchema.safeParse(answer); if (!parsed.success) return UNUSABLE;
  const view = parsed.data, home = view.env.HOME, label = LABELS[view.runtime];
  if (!home || !isAbsolute(home) || view.env[view.runtime === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] !== home || view.env[view.runtime === 'claude' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] !== undefined) return UNUSABLE;
  const auth = Object.fromEntries(Object.entries(view.env).filter(([key]) => !HOME_KEYS.includes(key)));
  let env: Record<string, string>; try { env = minimalEnvironment(view.runtime, home, auth, {}, base); } catch { return UNUSABLE; }
  const executable = findExecutable(view.runtime, env.PATH ?? '/usr/bin:/bin');
  if (!executable) return `${label} is not installed on this device: the ${view.runtime} command was not found on PATH.`;
  if (!existsSync(view.cwd)) return `The thread's folder no longer exists: ${view.cwd}`;
  const args = view.runtime === 'claude'
    ? ['--resume', view.nativeSessionId, '--model', view.model, ...(await claudeTakesEffort(executable, view.cwd, minimalEnvironment('claude', home, {}, {}, base)) ? ['--effort', view.effort] : []),
      '--settings', JSON.stringify(CLAUDE_FLAG_SETTINGS)]
    : ['resume', view.nativeSessionId, '-m', view.model, '-c', `model_reasoning_effort="${view.effort}"`];
  return { executable, args, env, cwd: view.cwd, label };
}

/**
 * Keeps the command alive through the signals that end the native CLI, so it can always detach (D47). A terminal's Ctrl-C already
 * reaches the whole foreground group, the native CLI included, so SIGINT is forwarded only when no terminal is attached; SIGTERM and
 * SIGHUP are forwarded. A signal before the native CLI starts is remembered: the command then hands the thread back without starting it.
 */
function holdSignals() {
  const terminal = isatty(0); let child: ChildProcess | undefined; let received: NodeJS.Signals | undefined;
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      if (!child) { received ??= signal; return; }
      if (child.exitCode === null && child.signalCode === null && (signal !== 'SIGINT' || !terminal)) child.kill(signal);
    };
    process.on(signal, handler); return () => { process.off(signal, handler); };
  });
  return { received: () => received, watch: (next: ChildProcess) => { child = next; }, release: () => { handlers.forEach((off) => off()); } };
}

/** Runs the native CLI with the terminal's stdio and waits for it: its exit code (128 + the signal number when a signal ended it). */
function run(launch: Launch, hold: ReturnType<typeof holdSignals>): Promise<{ code: number; exitCode: number | null } | { failure: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'inherit' }); }
    catch (error) { resolve({ failure: `${launch.label} could not start. ${sentence(error)}` }); return; }
    hold.watch(child);
    // Only a start failure ends the wait here; a later error (a forwarded signal that could not be sent) still waits for the exit.
    child.on('error', (error) => { if (child.pid === undefined) resolve({ failure: `${launch.label} could not start. ${sentence(error)}` }); });
    child.once('exit', (code, signal) => resolve({ code: code ?? 128 + (signal ? constants.signals[signal] : 0), exitCode: code }));
  });
}

/** Hands the thread back to Jevellan; false when the detach did not reach the daemon (the thread stays attached). */
async function handBack(homes: Homes, options: ThreadCommandOptions, threadId: string, exitCode: number | null): Promise<boolean> {
  const detached = await call(homes, options, threadId, 'detach', { schema: 'thread-detach-request-v1', exitCode });
  if (!detached.ok) { if (detached.refused) console.error(detached.message); console.error(staysAttached(threadId)); return false; }
  console.log(back(detached.value)); return true;
}

/**
 * `jevellan thread attach <threadId>` (brief phase 7, design 3.7, D47): attaches the thread on this device's daemon, resumes its native
 * session in the terminal and, whenever the native CLI ends, detaches so Jevellan adopts the session the terminal left. Answers the
 * exit code: the native CLI's, or 1 when the thread could not be attached, the native CLI could not start, or the detach failed.
 * Failures print one sentence each, never a stack trace.
 */
export async function attachThread(threadId: string, options: ThreadCommandOptions = {}): Promise<number> {
  let homes: Homes; try { homes = options.homes ?? new Homes(); } catch (error) { console.error(sentence(error)); return 1; }
  const hold = holdSignals();
  try {
    const attached = await call(homes, options, threadId, 'attach', { schema: 'thread-attach-request-v1' });
    if (!attached.ok) { console.error(attached.message); return 1; }
    const launch = await prepare(attached.value, options.env ?? process.env);
    const early = hold.received();
    if (typeof launch === 'string' || early) {
      if (typeof launch === 'string') console.error(launch);
      const handed = await handBack(homes, options, threadId, null);
      return handed && early ? 128 + constants.signals[early] : 1;
    }
    console.log(`Resuming the thread in ${launch.label}. Exit ${launch.label} to hand the thread back to Jevellan.`);
    const ended = await run(launch, hold);
    if ('failure' in ended) { console.error(ended.failure); await handBack(homes, options, threadId, null); return 1; }
    return await handBack(homes, options, threadId, ended.exitCode) ? ended.code : 1;
  } finally { hold.release(); }
}

/** `jevellan thread detach <threadId>` (D47): hands back a thread whose terminal could not detach. Changes nothing for a thread that is not attached. */
export async function detachThread(threadId: string, options: ThreadCommandOptions = {}): Promise<number> {
  let homes: Homes; try { homes = options.homes ?? new Homes(); } catch (error) { console.error(sentence(error)); return 1; }
  const detached = await call(homes, options, threadId, 'detach', { schema: 'thread-detach-request-v1', exitCode: null });
  if (!detached.ok) { console.error(detached.message); return 1; }
  console.log(back(detached.value)); return 0;
}
