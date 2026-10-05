import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import { ThreadAttachViewSchema, ThreadDetachViewSchema, minimalEnvironment, resolvedPath, type Project, type ProjectHub, type Thread } from '@jevellan/core';
import type { NativeJournal } from '@jevellan/mesh';
import { ATTACH_RUNTIMES_ONLY, NO_SESSION_TO_ATTACH, THREAD_NOT_FOUND, threadRunsOn } from './copy.js';
import type { MainCheckout } from './main-checkout.js';
import type { DeviceRoster } from './placement.js';
import type { CoordinatorStore, ThreadStore } from './stores.js';
import type { ThreadRunner } from './thread-runner.js';
import type { ThreadTranscripts } from './transcript.js';

export type ThreadAttachView = z.infer<typeof ThreadAttachViewSchema>;
export type ThreadDetachView = z.infer<typeof ThreadDetachViewSchema>;
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
/** The runtimes whose native CLI the attach command resumes (brief phase 7). */
const ATTACH_RUNTIMES = ['claude', 'codex'] as const;
type AttachRuntime = typeof ATTACH_RUNTIMES[number];
const attachRuntime = (runtime: string): runtime is AttachRuntime => (ATTACH_RUNTIMES as readonly string[]).includes(runtime);
/** The account's own authentication variables, as a turn launch passes them (Codex keeps its login in the account home). */
const AUTH_KEYS: Record<AttachRuntime, readonly string[]> = { claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], codex: [] };

/**
 * The attach environment (brief phase 7): only the account home variables (`HOME`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`) and the
 * account's authentication variables; the command merges them into its own minimal environment.
 */
export function attachEnvironment(runtime: AttachRuntime, account: { home: string; env: Record<string, string> }): Record<string, string> {
  const auth: Record<string, string> = {};
  for (const key of AUTH_KEYS[runtime]) if (account.env[key]) auth[key] = account.env[key];
  return minimalEnvironment(runtime, account.home, auth, {}, {});
}
/**
 * The session the terminal left (brief phase 7): the newest journal in the account home whose working directory is the thread's
 * and that changed after the attach started (it covers a CLI that forks the session id on resume). Sessions Jevellan runs itself
 * there are never taken (`exclude`: other threads and the project's coordinator, which works in the same checkout as main threads).
 */
export function adoptedSession(journals: readonly NativeJournal[], cwd: string, startedAt: string, exclude: ReadonlySet<string> = new Set()): string | undefined {
  const since = Date.parse(startedAt); const where = resolvedPath(cwd);
  return [...journals].sort((a, b) => b.mtimeMs - a.mtimeMs)
    .find((journal) => journal.mtimeMs > since && journal.cwd !== null && !exclude.has(journal.nativeId) && resolvedPath(journal.cwd) === where)?.nativeId;
}

export type ThreadAttachOptions = {
  deviceId: string; deviceName: string;
  store: Pick<ThreadStore, 'get' | 'all'>; coordinators: Pick<CoordinatorStore, 'get'>;
  hub: Pick<ProjectHub, 'thread'>; roster(): Promise<DeviceRoster>;
  runner(threadId: string): Pick<ThreadRunner, 'attach' | 'detach'> | undefined;
  project(projectId: string): Promise<Project>;
  main: Pick<MainCheckout, 'ready'>;
  accounts: Pick<AccountService, 'resolve'>;
  transcripts: Pick<ThreadTranscripts, 'sessions'>;
};

/**
 * Terminal takeover on the thread's owner device (brief phase 7, design 3.7): the local control routes' attach and detach. Attach
 * answers what the command needs to resume the thread's native session in its working directory; it is the only answer that carries a
 * native session id and account credentials, and it never leaves the loopback socket (D46). Detach adopts the session the terminal
 * left and hands the thread back to Jevellan.
 */
export class ThreadAttach {
  readonly #o: ThreadAttachOptions;
  constructor(o: ThreadAttachOptions) { this.#o = o; }
  /** A thread on this device, or the refusal for a thread on another device (409 naming it) or none (404). */
  async #local(threadId: string): Promise<{ thread: Thread; runner: Pick<ThreadRunner, 'attach' | 'detach'> }> {
    const thread = this.#o.store.get(threadId); const runner = thread && this.#o.runner(threadId);
    if (thread && runner) return { thread, runner };
    const index = (await this.#o.hub.thread(threadId))?.document;
    if (!index || index.ownerDeviceId === this.#o.deviceId) throw refuse(THREAD_NOT_FOUND, 404);
    const name = (await this.#o.roster()).devices.find((view) => view.device.id === index.ownerDeviceId)?.device.name;
    throw refuse(threadRunsOn(name ?? index.ownerDeviceId), 409);
  }
  /**
   * Attach (D46): an idle, waiting or in-review thread with a session, on Claude or Codex. A main thread takes its checkout claim for
   * this process again (another work that took it meanwhile refuses), and the account is resolved, before the thread is `attached`.
   */
  async attach(threadId: string): Promise<ThreadAttachView> {
    const { runner } = await this.#local(threadId);
    const { thread, prepared } = await runner.attach(async (current) => {
      const runtime = current.placement.runtime;
      if (!attachRuntime(runtime)) throw refuse(ATTACH_RUNTIMES_ONLY, 409);
      if (current.isolation === 'main' && !(await this.#o.main.ready(await this.#o.project(current.projectId), current))) throw refuse(NO_SESSION_TO_ATTACH, 409);
      return { runtime, env: attachEnvironment(runtime, await this.#o.accounts.resolve(current.placement.accountId)) };
    });
    return ThreadAttachViewSchema.parse({ schema: 'thread-attach-v1', cwd: thread.cwd, runtime: prepared.runtime, nativeSessionId: thread.nativeSessionId,
      model: thread.placement.model, effort: thread.placement.effortEffective, env: prepared.env, deviceName: this.#o.deviceName });
  }
  /**
   * Detach: the session the terminal left continues the thread, and messages that waited run next. A thread that is not attached
   * (detached before, or stopped meanwhile) is unchanged. The command's exit code changes nothing here.
   */
  async detach(threadId: string): Promise<ThreadDetachView> {
    const { runner } = await this.#local(threadId);
    const result = await runner.detach(async (thread) => {
      const exclude = new Set(this.#o.store.all().flatMap((other) => other.id !== thread.id && other.nativeSessionId ? [other.nativeSessionId] : []));
      const coordinator = this.#o.coordinators.get(thread.projectId).session?.nativeSessionId; if (coordinator) exclude.add(coordinator);
      return adoptedSession(await this.#o.transcripts.sessions(thread), thread.cwd, thread.attach?.startedAt ?? thread.createdAt, exclude);
    });
    return ThreadDetachViewSchema.parse({ schema: 'thread-detach-v1', ...result });
  }
}
