import { GitSettings, gitFailureMessage, runOwnedCommand, type CommandResult, type Homes, type SecretRedactor } from '@jevellan/core';

/** The last `max` characters (verification and setup tails, D49). */
export const tail = (text: string, max = 4000): string => text.length <= max ? text : text.slice(-max);
/** The first non-empty line, trimmed. */
export const firstLine = (text: string): string => text.split('\n').find((line) => line.trim())?.trim() ?? '';

export const GIT_NETWORK_TIMEOUT_MS = 120_000;
export const THREAD_REF_PREFIX = 'refs/jevellan/threads/';
export const threadBaseRef = (threadId: string): string => `${THREAD_REF_PREFIX}${threadId}/base`;

/**
 * Git for thread worktrees and publication. Mirrors `GitWorkspace.#git` (no pager, the device Git settings environment
 * with the daemon's own HOME, redacted failure text) with explicit timeouts, and never loosens its main-only guards.
 */
export class ThreadGit {
  readonly #homes: Homes;
  readonly #redactor: SecretRedactor;
  constructor(o: { homes: Homes; redactor: SecretRedactor }) { this.#homes = o.homes; this.#redactor = o.redactor; }
  /** `env` adds variables over the Git settings environment (the machine identity for leftover commits, D15). */
  async run(cwd: string, args: string[], o: { permitted?: number[]; timeoutMs?: number; input?: string; signal?: AbortSignal; env?: Record<string, string> } = {}): Promise<CommandResult> {
    const result = await runOwnedCommand('git', ['--no-pager', ...args], { cwd, env: { ...new GitSettings(this.#homes).environment(), ...o.env }, redactOutput: false,
      timeoutMs: o.timeoutMs ?? 30_000, ...(o.input === undefined ? {} : { input: o.input }), ...(o.signal ? { signal: o.signal } : {}) });
    if (result.timedOut) throw new Error(`Git ${args[0]} did not finish in time.`);
    if (result.code !== 0 && !(o.permitted ?? []).includes(result.code)) throw new Error(`Git ${args[0]} failed (${result.code}): ${gitFailureMessage(result.stderr.trim(), this.#redactor)}`);
    return result;
  }
  async #value(cwd: string, args: string[]): Promise<string> { return (await this.run(cwd, args, { permitted: [1] })).stdout.trim(); }
  /** The machine identity for thread turns (D15): `user.name` and `user.email` as Jevellan's own git sees them. */
  async identity(projectPath: string): Promise<{ name: string; email: string } | undefined> {
    const [name, email] = await Promise.all([this.#value(projectPath, ['config', '--get', 'user.name']), this.#value(projectPath, ['config', '--get', 'user.email'])]);
    return name && email ? { name, email } : undefined;
  }
  /** The raw `remote.origin.url` before any insteadOf rewrite (D18); null without an origin. */
  async remoteUrl(cwd: string): Promise<string | null> {
    if (!(await this.run(cwd, ['remote'])).stdout.split('\n').map((name) => name.trim()).includes('origin')) return null;
    return await this.#value(cwd, ['config', '--get', 'remote.origin.url']) || null;
  }
  async resolve(cwd: string, ref: string): Promise<string | null> {
    return (await this.run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { permitted: [1, 128] })).stdout.trim() || null;
  }
  /**
   * The only fetch threads run (D14, D143): into a private ref, with an empty refmap so `refs/remotes/origin/<base>`
   * stays put, no FETCH_HEAD and no followed tags, so a conversation step on the same checkout sees no change.
   */
  async fetchPrivate(repo: string, base: string, ref: string, signal?: AbortSignal): Promise<string> {
    if (!ref.startsWith(THREAD_REF_PREFIX)) throw new Error('Thread fetches write only private thread refs.');
    await this.run(repo, ['check-ref-format', '--branch', base]);
    await this.run(repo, ['fetch', '--refmap=', '--no-write-fetch-head', '--no-tags', 'origin', `refs/heads/${base}:${ref}`], { timeoutMs: GIT_NETWORK_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    const sha = await this.resolve(repo, ref);
    if (!sha) throw new Error('The fetched base branch could not be read.');
    return sha;
  }
}
