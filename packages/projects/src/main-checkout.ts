import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GitWorkspace, NOT_ON_MAIN, resolveProjectPath, type CheckoutOwner, type CheckoutOwnership, type Project, type SecretRedactor, type Thread, type ThreadLocal,
} from '@jevellan/core';
import { leftoverCommitSubject, mainCheckoutMessage } from './copy.js';
import type { ThreadGit } from './git.js';

/** The checkout claim of a main thread (brief 8.2 step 4): the thread is both the owner and its work. */
export const mainOwner = (thread: Pick<Thread, 'id' | 'title'>): CheckoutOwner => ({ conversationId: thread.id, conversationTitle: thread.title, workId: thread.id });
export type PreparedMain = { cwd: string; baseBranch: 'main'; baseCommit: string };
/** How an ended main thread's claim is settled again (phase 8): released as the thread left it, or the stop settlement (D29). */
export type CheckoutSettlement = 'published' | 'unchanged' | 'stop';
/** A failed preparation whose claim could not be given back either (D291): `claimKept` is why, and the sweeps release it later. */
export type ClaimKeptError = Error & { claimKept?: string };
/**
 * The checkout as a stop saw it when it refused because someone else had it (P8 review N-2): local main's tip and, when the checkout was
 * on main (another agent active there), its working tree digest. Off main the tree is the owner's branch, so no digest is taken.
 */
export type CheckoutSeen = NonNullable<NonNullable<ThreadLocal['unsettledCheckout']>['seen']>;
/** A stop that failed; `seen` is set on the first refusal because someone else had the checkout. */
export type StopRefusal = Error & { seen?: CheckoutSeen };
/**
 * What a stop did: `saved` is the ref of the commits it saved; `leftAsIs` says the checkout changed after an earlier refusal, so it was
 * given back without any git change (P8 review N-2).
 */
export type StopResult = { saved?: string; leftAsIs?: true };
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
  workspace(project: Project, thread: Pick<Thread, 'id' | 'title' | 'gitPolicy'>): GitWorkspace {
    return new GitWorkspace(thread.gitPolicy === 'external' ? { ...project, branchPolicy: 'external' } : project, this.#o.deviceId, this.#ownership(), mainOwner(thread), this.#o.redactor);
  }
  /**
   * Preparation, once per thread (D67 re-runs it only while no base was recorded): the outside activity check, the claim, then a clean
   * main fast-forwarded to origin. A failure after the claim releases it unchanged, since nothing ran in the checkout yet.
   */
  async prepare(project: Project, thread: Pick<Thread, 'id' | 'title'>): Promise<PreparedMain> {
    const ownership = this.#ownership(); const owner = mainOwner(thread); const path = this.path(project);
    try {
      await this.#o.outside?.assertIdle(project, path);
      await ownership.acquire(project, owner);
    } catch (error) { throw this.#error(project, error); }
    try {
      if (!(await this.onMain(project, thread))) throw new Error(NOT_ON_MAIN);
      return { cwd: path, baseBranch: 'main', baseCommit: await this.workspace(project, thread).prepare() };
    } catch (error) {
      const kept = await ownership.release(project, owner, { processesGone: true, commits: 'unchanged' }).then(() => undefined, (failure: unknown) => this.#error(project, failure).message);
      throw Object.assign(this.#error(project, error), kept === undefined ? {} : { claimKept: kept }) as ClaimKeptError;
    }
  }
  /** The claim is this thread's. */
  async #holds(project: Project, thread: Pick<Thread, 'id'>): Promise<boolean> {
    const claim = await this.#ownership().current(project);
    return !!claim?.held && claim.conversationId === thread.id && claim.workId === thread.id;
  }
  /** The claim for this process: kept as it is when it already names this process, else taken again (a restart left the old pid). */
  async #reclaim(project: Project, owner: CheckoutOwner): Promise<void> {
    const ownership = this.#ownership();
    try { await ownership.assert(project, owner); } catch { await ownership.acquire(project, owner); }
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
  /**
   * The branch the checkout works on: HEAD's, or while a rebase is unfinished the branch it rewrites (HEAD is detached meanwhile, so an
   * agent's own rebase onto main still counts as main).
   */
  async #workingBranch(ws: GitWorkspace): Promise<string> {
    if (await ws.rebaseInProgress()) {
      for (const name of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
        const path = resolve(ws.path, (await this.#o.git.run(ws.path, ['rev-parse', '--git-path', name])).stdout.trim());
        if (existsSync(path)) return readFileSync(path, 'utf8').trim();
      }
    }
    return ws.branch();
  }
  /**
   * Whether the claimed checkout works on main (P8 review TH-1). The owner may switch it to a branch of their own while the thread rests;
   * no turn then runs there (the runner rests the thread until main is back).
   */
  async onMain(project: Project, thread: Pick<Thread, 'id' | 'title'>): Promise<boolean> {
    try { return await this.#workingBranch(this.workspace(project, thread)) === 'refs/heads/main'; }
    catch (error) { throw this.#error(project, error); }
  }
  /** What a stop refused because someone else had the checkout records (P8 review N-2); nothing when main cannot be read. */
  async #seen(ws: GitWorkspace, onMain: boolean): Promise<CheckoutSeen | undefined> {
    try {
      const main = await this.#o.git.resolve(ws.path, 'refs/heads/main');
      return main ? { main, ...(onMain ? { tree: await ws.workingTreeDigest() } : {}) } : undefined;
    } catch { return undefined; }
  }
  /**
   * Whether the checkout is still as a refused stop saw it (P8 review N-2): local main at the same tip, and either on main with nothing
   * to commit, or the very working tree the refusal saw on main (the thread's own leftovers, which the stop then commits and saves).
   */
  async #asSeen(ws: GitWorkspace, seen: CheckoutSeen): Promise<boolean> {
    if (await this.#o.git.resolve(ws.path, 'refs/heads/main') !== seen.main) return false;
    if (await ws.branch() === 'refs/heads/main' && await ws.clean()) return true;
    return seen.tree !== undefined && await ws.workingTreeDigest() === seen.tree;
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
   * The checkout is the owner's too, so before anything is aborted, committed or reset it must work on main and no other agent may be
   * active in it (P8 review TH-1): a branch the owner switched to, with their own uncommitted files, is never touched. Such a refusal
   * throws a `StopRefusal` with what it saw (unless `seen` is given). `seen` is that record when a stop is tried again (P8 review N-2):
   * the stop then changes git only while the checkout is still as seen; otherwise the owner has changed it since, and the claim is
   * released `unchanged` with nothing committed, saved or reset (`leftAsIs`), and any of the thread's commits still on main stay there.
   */
  async stop(project: Project, thread: Thread, identity?: { name: string; email: string }, seen?: CheckoutSeen): Promise<StopResult> {
    const ownership = this.#ownership(); const owner = mainOwner(thread);
    let refused: CheckoutSeen | undefined;
    try {
      if (!(await this.#holds(project, thread))) return {};
      await this.#reclaim(project, owner);
      if (thread.gitPolicy === 'external' || project.branchPolicy === 'external') {
        await ownership.release(project, owner, { processesGone: true, commits: 'unchanged' });
        return {};
      }
      const ws = this.workspace(project, thread); const cwd = ws.path; const git = this.#o.git;
      if (await this.#workingBranch(ws) !== 'refs/heads/main') { if (!seen) refused = await this.#seen(ws, false); throw new Error(NOT_ON_MAIN); }
      try { await this.#o.outside?.assertIdle(project, cwd); }
      catch (error) { if (!seen) refused = await this.#seen(ws, true); throw error; }
      if (seen && !(await this.#asSeen(ws, seen))) {
        await ownership.release(project, owner, { processesGone: true, commits: 'unchanged' });
        return { leftAsIs: true };
      }
      if (await ws.rebaseInProgress()) await ws.abortRebase();
      if (await ws.branch() !== 'refs/heads/main') { if (!seen) refused = await this.#seen(ws, false); throw new Error(NOT_ON_MAIN); }
      await git.commitAll(cwd, leftoverCommitSubject(thread.title, thread.lastReport?.summary ?? thread.title), identity);
      await ws.fetch().catch(() => undefined);
      const head = await ws.head();
      const base = (await git.run(cwd, ['merge-base', 'HEAD', 'refs/remotes/origin/main'])).stdout.trim();
      const ref = `refs/jevellan/discard/${thread.id}/1`;
      // A stop that crashed after saving finds its own ref; any other commit there is never overwritten.
      const saved = await git.resolve(cwd, ref);
      if (!base || base === head) {
        // A settlement tried again after its reset (the release failed before, phase 8) still names the commits it saved.
        await ownership.release(project, owner, { processesGone: true, commits: saved ? 'discarded' : 'unchanged' });
        return saved ? { saved: ref } : {};
      }
      if (saved !== head) { if (saved) throw new Error('The saved commits ref already holds other work.'); await ws.saveRef('discard', 1); }
      await ownership.assert(project, owner);
      await git.run(cwd, ['reset', '--hard', base]);
      if (await ws.head() !== base || !await ws.clean()) throw new Error('The checkout did not return to main cleanly.');
      await ownership.release(project, owner, { processesGone: true, commits: 'discarded' });
      return { saved: ref };
    } catch (error) { throw Object.assign(this.#error(project, error), refused ? { seen: refused } : {}) as StopRefusal; }
  }
  /**
   * Settles an ended thread's claim again (phase 8, the retry of D291), after its process is gone. Nothing is left to do once the claim
   * is no longer this thread's (released meanwhile, or by hand). A release takes the claim for this process first. The stop settlement
   * is `stop` itself with what its first refusal saw (`seen`): it waits while the checkout is off main or another agent works in it, and
   * once it is back it commits, saves and resets only when the checkout is still as that refusal saw it (P8 review N-2); a checkout the
   * owner changed meanwhile is released as it is. Returns what the stop did; failures keep the claim, in thread words.
   */
  async settle(project: Project, thread: Thread, settlement: CheckoutSettlement, identity?: { name: string; email: string }, seen?: CheckoutSeen): Promise<StopResult> {
    if (settlement === 'stop') return this.stop(project, thread, identity, seen);
    const ownership = this.#ownership(); const owner = mainOwner(thread);
    try {
      if (!(await this.#holds(project, thread))) return {};
      await this.#reclaim(project, owner);
      await ownership.release(project, owner, { processesGone: true, commits: settlement });
      return {};
    } catch (error) { throw this.#error(project, error); }
  }
}
