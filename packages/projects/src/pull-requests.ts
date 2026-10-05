import {
  GitHubError, MergeResultViewSchema, isTerminal, newId, parseGitHubPullUrl, parseGitHubRemote, stableJson,
  type CoordinatorEvent, type GitHubRepository, type Project, type ProjectHub, type PullRequestState, type SecretRedactor, type Thread, type ThreadLocal,
} from '@jevellan/core';
import type { z } from 'zod';
import { MERGE_CHECKS_FAILING, MERGE_CONFLICTS, NOT_GITHUB, NO_PULL_REQUEST, PR_CLOSED, PR_NOT_OPEN, THREAD_NOT_FOUND, cleanupFailed, prStatusUnavailable } from './copy.js';
import type { ThreadGit } from './git.js';
import { pullRequestState, type GitHubAccess } from './publication.js';
import type { ThreadStore } from './stores.js';
import type { ThreadWorktree } from './worktree.js';

export type MergeResultView = z.infer<typeof MergeResultViewSchema>;
type PrChange = Extract<CoordinatorEvent, { kind: 'pr-update' }>['change'];
export type PullRequestTrackerOptions = {
  threads: Pick<ThreadStore, 'all' | 'get' | 'update' | 'local' | 'updateLocal' | 'ledgers'>;
  github: GitHubAccess; git: ThreadGit; worktrees: Pick<ThreadWorktree, 'repository' | 'remove'>;
  /** The project as stored in shared state. */
  project(projectId: string): Promise<Project>;
  toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void>;
  /**
   * Applies a merge or close on the thread's own chain (D95): a running fix turn is stopped and a publication finishes
   * first. Without it the transition applies at once.
   */
  transition?(threadId: string, apply: () => Promise<void>): Promise<void>;
  /** Hub index of a thread owned elsewhere, for `jevellan_pr_status` (phase 5). */
  hub?: Pick<ProjectHub, 'thread'>;
  redactor: SecretRedactor; now?(): number;
  /** 60 s polling when periodic (brief 8.5); tests drive `poll()` directly. */
  pollMs?: number; periodic?: boolean;
};
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
const comparable = (pr: PullRequestState | undefined) => pr && stableJson({ ...pr, updatedAt: '' });
type Read = { pr: PullRequestState | null; reason?: string };

/**
 * Pull request tracking for every local thread whose pull request is open, whatever its state (brief 8.5, D95). Checks and
 * conflicts reach the coordinator once per head commit and value (D68); merged threads become `done`, closed ones `stopped`
 * (D69), and both lose their worktree and local branch. Polling errors keep the last state and leave one notice per error
 * kind. Merges are squash merges of the reviewed head, refused for conflicts or failing checks (D75).
 */
export class PullRequestTracker {
  readonly #o: PullRequestTrackerOptions & { now(): number; pollMs: number };
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #transitions = new Map<string, Promise<void>>();
  readonly #errors = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #polling: Promise<void> | undefined;
  #closed = false;
  constructor(o: PullRequestTrackerOptions) { this.#o = { ...o, now: o.now ?? Date.now, pollMs: o.pollMs ?? 60_000 }; }
  #at(): string { return new Date(this.#o.now()).toISOString(); }
  /** One operation per thread at a time, so a poll and a merge never both apply the same transition. */
  #serial<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(threadId) ?? Promise.resolve()).then(task);
    const chain = result.then(() => undefined, () => undefined); this.#chains.set(threadId, chain);
    void chain.then(() => { if (this.#chains.get(threadId) === chain) this.#chains.delete(threadId); });
    return result;
  }
  start(): void {
    if (!this.#o.periodic || this.#closed || this.#timer) return;
    const tick = () => { this.#timer = undefined; void this.poll().finally(() => { if (!this.#closed) schedule(); }); };
    const schedule = () => { this.#timer = setTimeout(tick, this.#o.pollMs); this.#timer.unref(); };
    schedule();
  }
  async close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    await this.#polling?.catch(() => undefined);
    await Promise.allSettled([...this.#transitions.values()]);
  }
  /**
   * Every local thread with an open pull request, one after another. A failure on one thread never stops the others, and a
   * merge or close waiting for its thread's chain does not hold up the rest; the poll ends when the transitions it found
   * are applied.
   */
  poll(): Promise<void> {
    this.#polling ??= (async () => {
      for (const thread of this.#o.threads.all()) {
        if (this.#closed) break;
        if (thread.pr?.state === 'open') await this.#read(thread.id, false).catch(() => undefined);
      }
      await Promise.allSettled([...this.#transitions.values()]);
    })().finally(() => { this.#polling = undefined; });
    return this.#polling;
  }
  /** On demand (the UI refresh): reads GitHub now and applies any transition before returning. */
  async refresh(threadId: string): Promise<PullRequestState | null> { return (await this.#read(threadId, true)).pr; }
  async #repository(projectId: string): Promise<GitHubRepository> {
    const project = await this.#o.project(projectId);
    const remote = await this.#o.git.remoteUrl(this.#o.worktrees.repository(project));
    const repository = remote && parseGitHubRemote(remote);
    if (!repository) throw new Error(NOT_GITHUB);
    return repository;
  }
  /** `fromUrl`: a thread on another device is read from its pull request's own address, without this device's checkout (3.5.1 step 8). */
  async #fetch(projectId: string, pr: PullRequestState, fromUrl = false): Promise<PullRequestState> {
    const repository = (fromUrl ? parseGitHubPullUrl(pr.url) : null) ?? await this.#repository(projectId); const client = await this.#o.github.open();
    const pull = await client.getPull(repository, pr.number);
    const open = !pull.merged && pull.state === 'open';
    return pullRequestState(pull, open ? await client.checks(repository, pull.headSha) : pr.checks, this.#at());
  }
  #notice(thread: Thread, text: string): void {
    this.#o.threads.ledgers.thread(thread.projectId, thread.id).append({ type: 'notice', data: { schema: 'project-notice-v1', text, kind: 'error' } });
  }
  #read(threadId: string, wait: boolean): Promise<Read> {
    return this.#serial(threadId, async () => {
      const thread = this.#o.threads.get(threadId); if (!thread) throw refuse(THREAD_NOT_FOUND, 404);
      if (!thread.pr) return { pr: null, reason: NO_PULL_REQUEST };
      if (thread.pr.state !== 'open') return { pr: thread.pr };
      const pending = this.#transitions.get(threadId);
      if (pending) { if (wait) await pending; return { pr: this.#o.threads.get(threadId)?.pr ?? thread.pr }; }
      let next: PullRequestState;
      try { next = await this.#fetch(thread.projectId, thread.pr); }
      catch (error) {
        const message = this.#o.redactor.text(error instanceof Error ? error.message : String(error));
        const kind = error instanceof GitHubError ? error.kind : 'other';
        // Keep the last state; tell the thread's history once per kind of failure.
        if (this.#errors.get(threadId) !== kind) { this.#errors.set(threadId, kind); this.#notice(thread, prStatusUnavailable(message)); }
        return { pr: thread.pr, reason: message };
      }
      this.#errors.delete(threadId);
      if (next.state !== 'open') {
        const transition = this.#conclude(threadId, next);
        if (wait) await transition;
        return { pr: next };
      }
      await this.#open(thread, next);
      return { pr: next };
    });
  }
  /** Stores a changed open state and tells the coordinator about check and conflict transitions, once per head and value (D68). */
  async #open(thread: Thread, next: PullRequestState): Promise<void> {
    if (comparable(thread.pr) !== comparable(next)) {
      this.#o.threads.update(thread.id, (current) => ({ ...current, pr: next }),
        { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'pr-state', prNumber: next.number, pr: next } });
    }
    const local = this.#o.threads.local(thread.id);
    let notified: NonNullable<ThreadLocal['prNotified']> = local.prNotified?.headSha === next.headSha ? local.prNotified : { headSha: next.headSha };
    const changes: PrChange[] = [];
    if ((next.checks === 'failing' || next.checks === 'passing') && notified.checks !== next.checks) {
      changes.push(next.checks === 'failing' ? 'checks-failed' : 'checks-passed'); notified = { ...notified, checks: next.checks };
    }
    if (next.mergeable === 'conflict' && !notified.conflict) { changes.push('conflict'); notified = { ...notified, conflict: true }; }
    if (stableJson(notified) !== stableJson(local.prNotified ?? null)) this.#o.threads.updateLocal(thread.id, (current) => ({ ...current, prNotified: notified }));
    for (const change of changes) await this.#tell(thread, next.number, change);
  }
  async #tell(thread: Thread, prNumber: number, change: PrChange): Promise<void> {
    const at = this.#o.now();
    await this.#o.toCoordinator(thread.projectId, { schema: 'coordinator-event-v1', kind: 'pr-update', id: newId('cev', at), at: new Date(at).toISOString(), threadId: thread.id, prNumber, change });
  }
  /**
   * Merged -> `done`, closed -> `stopped` with its reason (D69); then the coordinator hears it and the worktree and local
   * branch go (the remote branch stays). One transition per thread is in flight; it re-checks the stored state when it runs.
   */
  #conclude(threadId: string, pr: PullRequestState): Promise<void> {
    const pending = this.#transitions.get(threadId); if (pending) return pending;
    const apply = async () => {
      const thread = this.#o.threads.get(threadId);
      if (!thread?.pr || thread.pr.state !== 'open') return;
      const merged = pr.state === 'merged'; const at = this.#at();
      const updated = this.#o.threads.update(threadId, (current) => {
        // A thread that already ended keeps its end; a merge still marks its work done, a close keeps its own reason.
        const ended = isTerminal(current.state);
        const next: Thread = { ...current, pr, endedAt: current.endedAt ?? at };
        if (merged) { next.state = 'done'; delete next.stateReason; } else if (!ended) { next.state = 'stopped'; next.stateReason = PR_CLOSED; }
        return next;
      }, { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'pr-state', prNumber: pr.number, pr } });
      try { await this.#tell(updated, pr.number, merged ? 'merged' : 'closed'); }
      finally {
        // The thread has concluded either way: its worktree goes even when the coordinator could not be told.
        try {
          await this.#o.worktrees.remove(await this.#o.project(updated.projectId), updated);
          this.#o.threads.ledgers.thread(updated.projectId, threadId).append({ type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'cleanup', ...(updated.branch ? { branch: updated.branch } : {}) } });
        } catch (error) { this.#notice(updated, cleanupFailed(this.#o.redactor.text(error instanceof Error ? error.message : String(error)))); }
      }
    };
    const transition = (this.#o.transition ? this.#o.transition(threadId, apply) : apply()).finally(() => { this.#transitions.delete(threadId); });
    this.#transitions.set(threadId, transition);
    return transition;
  }
  /** Squash merge of the reviewed head from the UI (brief 8.5); success applies the merged transition before returning. */
  merge(threadId: string): Promise<MergeResultView> {
    return this.#serial(threadId, async () => {
      const thread = this.#o.threads.get(threadId); if (!thread) throw refuse(THREAD_NOT_FOUND, 404);
      const pr = thread.pr; if (!pr) throw refuse(NO_PULL_REQUEST, 409);
      if (pr.state !== 'open' || this.#transitions.has(threadId)) throw refuse(PR_NOT_OPEN, 409);
      if (pr.mergeable === 'conflict') throw refuse(MERGE_CONFLICTS, 409);
      if (pr.checks === 'failing') throw refuse(MERGE_CHECKS_FAILING, 409);
      let message: string;
      try {
        const result = await (await this.#o.github.open()).merge(await this.#repository(thread.projectId), pr.number, pr.headSha);
        if (!result.merged) throw refuse(result.message, 409);
        message = result.message;
      } catch (error) {
        if (error instanceof GitHubError || (error instanceof Error && error.message === NOT_GITHUB)) throw refuse(error.message, 409);
        throw error;
      }
      await this.#conclude(threadId, { ...pr, state: 'merged', updatedAt: this.#at() });
      return MergeResultViewSchema.parse({ schema: 'pull-request-merge-view-v1', merged: true, message });
    });
  }
  /**
   * `jevellan_pr_status`: fresh from GitHub. A local thread is refreshed (with its transitions); a thread owned by another
   * device is read without changing anything here.
   */
  async fresh(projectId: string, threadId: string): Promise<Read> {
    const local = this.#o.threads.get(threadId);
    if (local) { if (local.projectId !== projectId) throw refuse(THREAD_NOT_FOUND, 404); return this.#read(threadId, true); }
    const index = (await this.#o.hub?.thread(threadId))?.document;
    if (!index || index.projectId !== projectId) throw refuse(THREAD_NOT_FOUND, 404);
    if (!index.pr) return { pr: null, reason: NO_PULL_REQUEST };
    if (index.pr.state !== 'open') return { pr: index.pr };
    try { return { pr: await this.#fetch(projectId, index.pr, true) }; }
    catch (error) { return { pr: index.pr, reason: this.#o.redactor.text(error instanceof Error ? error.message : String(error)) }; }
  }
}
