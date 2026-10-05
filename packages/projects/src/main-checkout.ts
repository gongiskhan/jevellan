import {
  GitWorkspace, resolveProjectPath, type CheckoutOwner, type CheckoutOwnership, type Project, type SecretRedactor, type Thread,
} from '@jevellan/core';
import { LEAVE_GIT_MAIN, leftoverCommitSubject, mainCheckoutMessage } from './copy.js';
import type { ThreadGit } from './git.js';

/** The checkout claim of a main thread (brief 8.2 step 4): the thread is both the owner and its work. */
export const mainOwner = (thread: Pick<Thread, 'id' | 'title'>): CheckoutOwner => ({ conversationId: thread.id, conversationTitle: thread.title, workId: thread.id });
export type PreparedMain = { cwd: string; baseBranch: 'main'; baseCommit: string };
export type MainCheckoutOptions = {
  git: ThreadGit; redactor: SecretRedactor; deviceId: string; deviceName: string;
  /** The daemon's one `CheckoutOwnership`, shared with conversations (one pid per daemon). Without it main threads cannot run here. */
  ownership?: CheckoutOwnership | undefined;
  /** The external activity guard conversations use: no main thread starts while another agent works in the checkout. */
  outside?: { assertIdle(project: Project, path: string): Promise<void> } | undefined;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * A main thread's hold on the project checkout of its device (brief 8.2 step 4 main, 8.4 main, design 3.6). Preparation claims
 * `CheckoutOwnership` as `{ conversationId: threadId, conversationTitle: title, workId: threadId }`, so conversations and other main
 * threads are refused with `{project} on {device} is in use by "{title}".`, and runs `GitWorkspace.prepare()` once (clean main, fast
 * forward; no branch switch). Every later step re-claims for this process first, since the claim names the daemon's pid. Errors reach
 * threads in thread words (D44).
 */
export class MainCheckout {
  readonly #o: MainCheckoutOptions;
  constructor(o: MainCheckoutOptions) { this.#o = o; }
  #ownership(): CheckoutOwnership {
    if (!this.#o.ownership) throw new Error('Checkout ownership is not available on this device.');
    return this.#o.ownership;
  }
  #error(project: Project, error: unknown): Error {
    return new Error(mainCheckoutMessage(this.#o.redactor.text(message(error)), { projectName: project.name, deviceId: this.#o.deviceId, deviceName: this.#o.deviceName }));
  }
  /** The project checkout on this device. */
  path(project: Project): string { return resolveProjectPath(project, this.#o.deviceId, this.#o.deviceName); }
  /** Git on the checkout as this thread's owned work: every write asserts the claim and main. */
  workspace(project: Project, thread: Pick<Thread, 'id' | 'title'>): GitWorkspace {
    return new GitWorkspace(project, this.#o.deviceId, this.#ownership(), mainOwner(thread), this.#o.redactor);
  }
  /**
   * Preparation, once per thread (D67 re-runs it only while no base was recorded): the outside activity check, the claim, then a clean
   * main fast-forwarded to origin. A failure after the claim releases it unchanged, since nothing ran in the checkout yet.
   */
  async prepare(project: Project, thread: Pick<Thread, 'id' | 'title'>): Promise<PreparedMain> {
    if (project.branchPolicy !== 'main') throw new Error(LEAVE_GIT_MAIN);
    const ownership = this.#ownership(); const owner = mainOwner(thread); const path = this.path(project);
    try {
      await this.#o.outside?.assertIdle(project, path);
      await ownership.acquire(project, owner);
    } catch (error) { throw this.#error(project, error); }
    try {
      return { cwd: path, baseBranch: 'main', baseCommit: await this.workspace(project, thread).prepare() };
    } catch (error) {
      await ownership.release(project, owner, { processesGone: true, commits: 'unchanged' }).catch(() => undefined);
      throw this.#error(project, error);
    }
  }
  /**
   * Whether the thread was prepared; if so the claim is this process's again (a restart left the old pid, which `assert` refuses, and
   * `acquire` reclaims a claim whose process is gone). A claim another work took meanwhile is refused with its title.
   */
  async ready(project: Project, thread: Pick<Thread, 'id' | 'title' | 'cwd' | 'baseCommit'>): Promise<boolean> {
    if (!thread.cwd || !thread.baseCommit) return false;
    const ownership = this.#ownership(); const owner = mainOwner(thread);
    try { await ownership.assert(project, owner); }
    catch { try { await ownership.acquire(project, owner); } catch (error) { throw this.#error(project, error); } }
    return true;
  }
  /** Gives the checkout back after a publication (`published`) or a conclusion without changes (`unchanged`); only after the turn's process is gone. */
  async release(project: Project, thread: Pick<Thread, 'id' | 'title'>, commits: 'published' | 'unchanged'): Promise<void> {
    await this.#ownership().release(project, mainOwner(thread), { processesGone: true, commits });
  }
  /**
   * A stopped main thread (D29, D289), after its process is gone: an unfinished rebase is aborted, leftovers are committed, and commits
   * that are not on main (as last fetched; offline the last fetch decides) are saved at `refs/jevellan/discard/<threadId>/1` before the
   * checkout is reset to where they started, so the checkout is a clean main again; the claim is released `discarded`, or `unchanged`
   * without such commits. Returns the saved ref. A thread that holds no claim changes nothing. Failures keep the claim (the caller says so).
   */
  async stop(project: Project, thread: Thread, identity?: { name: string; email: string }): Promise<{ saved?: string }> {
    const ownership = this.#ownership(); const owner = mainOwner(thread);
    try {
      const claim = await ownership.current(project);
      if (!claim?.held || claim.conversationId !== thread.id || claim.workId !== thread.id) return {};
      await ownership.acquire(project, owner);
      const ws = this.workspace(project, thread); const cwd = ws.path; const git = this.#o.git;
      if (await ws.rebaseInProgress()) await ws.abortRebase();
      await git.commitAll(cwd, leftoverCommitSubject(thread.title, thread.lastReport?.summary ?? thread.title), identity);
      await ws.fetch().catch(() => undefined);
      const head = await ws.head();
      const base = (await git.run(cwd, ['merge-base', 'HEAD', 'refs/remotes/origin/main'])).stdout.trim();
      if (!base || base === head) {
        await ownership.release(project, owner, { processesGone: true, commits: 'unchanged' });
        return {};
      }
      const ref = `refs/jevellan/discard/${thread.id}/1`;
      // A stop that crashed after saving finds its own ref; any other commit there is never overwritten.
      const saved = await git.resolve(cwd, ref);
      if (saved !== head) { if (saved) throw new Error('The saved commits ref already holds other work.'); await ws.saveRef('discard', 1); }
      await ownership.assert(project, owner);
      await git.run(cwd, ['reset', '--hard', base]);
      if (await ws.head() !== base || !await ws.clean()) throw new Error('The checkout did not return to main cleanly.');
      await ownership.release(project, owner, { processesGone: true, commits: 'discarded' });
      return { saved: ref };
    } catch (error) { throw this.#error(project, error); }
  }
}
