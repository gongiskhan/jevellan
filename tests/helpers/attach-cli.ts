// Shared harness for terminal takeover (brief phase 7; design 3.7; D300-D303): the installed command (`bin/jevellan.mjs`) as a real
// process against a `projectFixture({ control: true })` daemon, with simulated `claude` and `codex` CLIs (`tests/fixtures/agent-cli.mjs`)
// first on PATH. The owner's own CLIs and homes are never reachable: PATH holds only the fixture directory and the system directories,
// and HOME is the fixture's user directory.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThreadCreatedViewSchema, type CoordinatorEvent, type ModelOption } from '../../packages/core/dist/index.js';
import { FakeRuntime } from '../../packages/runtime-contract/dist/index.js';
import { FIXTURE_MENU, type ProjectFixture } from './project-fixture.js';

const BIN = fileURLToPath(new URL('../../bin/jevellan.mjs', import.meta.url));
const AGENT_CLI = new URL('../fixtures/agent-cli.mjs', import.meta.url).href;
/** The fixture menu plus one Claude and one Codex entry, so threads place on the runtimes a terminal can take over. */
export const ATTACH_MENU: ModelOption[] = [...FIXTURE_MENU,
  { id: 'claude_fixture', runtime: 'claude', model: 'scripted-model', label: 'Claude fixture', description: 'Simulated model.', efforts: ['high'], enabled: true },
  { id: 'codex_fixture', runtime: 'codex', model: 'scripted-model', label: 'Codex fixture', description: 'Simulated model.', efforts: ['high'], enabled: true }];
export const BACK = 'The thread is back in Jevellan.';
export const BACK_ADOPTED = 'The thread is back in Jevellan and continues from the session in this terminal.';
/** Set in the command's own environment; the native CLI must never receive them. */
export const CANARY = `fixture-${randomUUID()}`;

/** A fake runtime registered under a real runtime id, so threads place on `claude` or `codex` and write that runtime's native journals. */
export function named(id: 'claude' | 'codex'): FakeRuntime {
  const runtime = new FakeRuntime(); Object.defineProperty(runtime, 'id', { value: id }); return runtime;
}
/** An owner-created thread on the fixture project, on the menu entry `modelId`. */
export async function start(f: ProjectFixture, title: string, task: string, modelId: string): Promise<string> {
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task, modelId });
  return created.threadId;
}
/** Waits until the thread rests idle and nothing else in the project is busy. */
export async function rest(f: ProjectFixture, threadId: string): Promise<void> {
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'idle'); await f.app.projectWork.idle('project');
}
/** A shared Claude subscription account with a secret token; its home is where the native CLI writes its sessions. */
export async function claudeAccount(f: ProjectFixture): Promise<{ secret: string; home: string }> {
  const secret = `fixture-${randomUUID()}`;
  const account = await f.app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Claude subscription', kind: 'subscription', secret });
  await f.app.accounts.check(account.account.id);
  return { secret, home: f.homes.at('homes', 'claude', account.account.id) };
}
/** The `[owner worked on thread ...]` lines waiting in the coordinator's queue for this thread. */
export const worked = (f: ProjectFixture, threadId: string) => f.coordinatorState().queue
  .filter((event: CoordinatorEvent) => event.kind === 'thread-user-message' && event.threadId === threadId && event.text.startsWith('[owner worked'));

export type AgentRecord = { name: 'claude' | 'codex'; pid: number; kind: 'help' | 'run' | 'signal' | 'exit' | 'no-home'; argv?: string[]; envKeys?: string[]; cwd?: string;
  tty?: boolean; sessionId?: string; authDigest?: string; signal?: string; code?: number };
export type Agents = { bin: string; records(): AgentRecord[]; started(count: number): Promise<AgentRecord> };
/** `claude` and `codex` executables in a fresh PATH directory, logging to one file; `effort: false` leaves `--effort` out of `claude --help`. */
export function agents(f: ProjectFixture, options: { effort?: boolean } = {}): Agents {
  const bin = join(f.root, `bin-${randomUUID()}`), log = join(f.root, `agents-${randomUUID()}.log`); mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nimport(${JSON.stringify(AGENT_CLI)}).then((cli) => cli.run(${JSON.stringify({ name, log, ...options })}));\n`, { mode: 0o755 });
  }
  // macOS adds `__CF_USER_TEXT_ENCODING` to every process that loads CoreFoundation, Node included: it is not from the command.
  const records = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as AgentRecord)
    .map((record) => record.envKeys ? { ...record, envKeys: record.envKeys.filter((key) => key !== '__CF_USER_TEXT_ENCODING') } : record) : [];
  return { bin, records, started: async (count) => (await f.waitFor(() => records().filter((record) => record.kind === 'run'), (runs) => runs.length >= count))[count - 1]! };
}

export type Command = { child: ChildProcess; output(): string; errors(): string; send(text: string): void; end(): void; exited: Promise<number | null> };
const commands: ChildProcess[] = [];
/**
 * `jevellan <args>` as the installed command runs it: the installation home from `JEVELLAN_HOME`, the fixture user's HOME, and
 * `path` as PATH. Its own process group, so a test can signal it alone. `terminal` runs it under `script`, in a pseudo-terminal
 * whose Ctrl-C reaches the whole foreground group, as a real terminal's does. `script` refuses a socket as its input (macOS), and
 * Node's stdio pipes are sockets, so `cat` feeds it through a real pipe; `script` ends once its input has ended and the command exited.
 */
export function jevellan(f: ProjectFixture, args: string[], options: { path?: string; home?: string; terminal?: boolean } = {}): Command {
  const env = { PATH: options.path ?? '/usr/bin:/bin', HOME: f.homes.userHome, JEVELLAN_HOME: options.home ?? f.homes.root, LANG: 'C', TERM: 'dumb', TMPDIR: f.root,
    JEVELLAN_STRETCH_TOKEN: CANARY, OPENAI_API_KEY: CANARY, GITHUB_TOKEN: CANARY };
  const child = options.terminal
    ? spawn('/bin/sh', ['-c', 'cat 2>/dev/null | exec /usr/bin/script -q /dev/null "$@"', 'sh', process.execPath, BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    : spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  commands.push(child);
  let output = '', errors = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); }); child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => { child.once('close', (code) => resolve(code)); });
  return { child, output: () => output, errors: () => errors, send: (text) => { child.stdin!.write(text); }, end: () => { child.stdin!.end(); }, exited };
}
/** Runs a command to its end: exit code and output. */
export async function finished(command: Command): Promise<{ code: number | null; output: string; errors: string }> {
  const code = await command.exited; return { code, output: command.output(), errors: command.errors() };
}
/** For `afterEach`: kills the process group of every command still running (a failed test leaves the native CLI waiting). */
export function stopCommands(): void {
  for (const child of commands.splice(0)) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already gone. */ } }
}
