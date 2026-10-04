import {
  GitHubClient, GitHubError, PullRequestStateSchema, gitFailureMessage, mapMergeable, parseGitHubRemote,
  type CheckoutOwnership, type GitHubPull, type Homes, type Project, type PublicationLeaseService, type PullRequestState, type SecretRedactor, type Thread, type ThreadLocal,
} from '@jevellan/core';
import {
  BRANCH_PUSHED_NO_TOKEN, NOT_GITHUB, NO_REMOTE, REMOTE_CREDENTIALS, VERIFICATION_HEAD_MOVED, commandTimedOut, githubRefused, leftoverCommitSubject, pullRequestBody,
} from './copy.js';
import { GIT_NETWORK_TIMEOUT_MS, tail, type ThreadGit } from './git.js';
import type { ProjectLedger } from './ledger.js';
import { TEST_TIMEOUT_MS, outputTail, runThreadCommand } from './verification.js';

/** The GitHub token is read when a publication or poll needs it, so a token saved later applies at once. */
export class GitHubAccess {
  readonly #o: { credential(): Promise<string | undefined>; fetch?: typeof fetch | undefined; baseUrl?: string | undefined; redactor: SecretRedactor };
  constructor(o: { credential(): Promise<string | undefined>; fetch?: typeof fetch | undefined; baseUrl?: string | undefined; redactor: SecretRedactor }) { this.#o = o; }
  async token(): Promise<string | undefined> { return (await this.#o.credential())?.trim() || undefined; }
  /** A client for one operation with a token already read. */
  client(token: string): GitHubClient {
    return new GitHubClient({ token: async () => token, redactor: this.#o.redactor, ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}), ...(this.#o.baseUrl ? { baseUrl: this.#o.baseUrl } : {}) });
  }
  /** Reads the token once; without one every request fails as `no-token` (`No GitHub token is saved.`). */
  async open(): Promise<GitHubClient> { return this.client(await this.token() ?? ''); }
}
/** The stored pull request state of a GitHub pull (brief 8.5 mapping). */
export function pullRequestState(pull: GitHubPull, checks: PullRequestState['checks'], at: string): PullRequestState {
  return PullRequestStateSchema.parse({ number: pull.number, url: pull.url, state: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
    headSha: pull.headSha, checks, mergeable: mapMergeable(pull.mergeableState), updatedAt: at });
}

export type VerificationResult = { status: 'passed' | 'failed' | 'skipped'; command: string | null; exitCode?: number; timedOut: boolean; tail: string; outputRef?: string; commit: string };
export type PublicationOutcome =
  | { kind: 'no-changes' }
  | { kind: 'verification-failed'; verification: VerificationResult }
  | { kind: 'no-remote'; reason: string }
  /** Pushed, but no pull request: no token, or the remote is not on GitHub (D23, D58). */
  | { kind: 'branch-only'; reason: string; branch: string }
  | { kind: 'pr'; result: 'pr-opened' | 'pr-updated'; pr: PullRequestState }
  | { kind: 'main-conflict'; files: string[] }
  | { kind: 'main-published'; commit: string }
  /** A git or GitHub failure, redacted and at most 400 characters (a thread state reason). */
  | { kind: 'error'; reason: string };
export type PublicationResult = { outcome: PublicationOutcome; pushedCommit?: string; verified?: VerificationResult };
export type WorktreePublication = {
  project: Project; thread: Thread; local: ThreadLocal; ledger: ProjectLedger;
  /** For the pull request body (brief 9.7, D83): the runtime display name and the menu label at placement. */
  labels: { runtimeName: string; modelLabel: string };
  signal?: AbortSignal | undefined;
  /** Called as soon as a push landed, so the next push leases against it even if the caller never sees the result (D27). */
  onPushed?(commit: string): void;
};
const reasonOf = (error: unknown, redactor: SecretRedactor) => redactor.text(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 400);
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Publication of a `done` thread (brief 8.4). Returns typed outcomes and never changes the thread's state: the runner acts
 * on them. It appends only the verification receipt and its output blob to the thread ledger. The worktree path commits
 * leftovers with the machine identity and no trailers (D86), concludes without changes when nothing was committed since the
 * base, verifies the exact HEAD, pushes the thread branch with a lease (D27) and finds or opens the pull request.
 */
export class ThreadPublication {
  readonly #git: ThreadGit; readonly #homes: Homes; readonly #redactor: SecretRedactor; readonly #github: GitHubAccess;
  readonly #deviceName: string; readonly #testTimeoutMs: number; readonly #now: () => number;
  /** Main isolation (phase 6) publishes under these; the worktree path needs neither. */
  readonly leases: PublicationLeaseService | undefined; readonly ownership: CheckoutOwnership | undefined;
  constructor(o: { git: ThreadGit; homes: Homes; redactor: SecretRedactor; github: GitHubAccess; deviceName: string; testTimeoutMs?: number; now?(): number;
    leases?: PublicationLeaseService; ownership?: CheckoutOwnership }) {
    this.#git = o.git; this.#homes = o.homes; this.#redactor = o.redactor; this.#github = o.github; this.#deviceName = o.deviceName;
    this.#testTimeoutMs = o.testTimeoutMs ?? TEST_TIMEOUT_MS; this.#now = o.now ?? Date.now; this.leases = o.leases; this.ownership = o.ownership;
  }
  async #head(cwd: string): Promise<string> { return (await this.#git.run(cwd, ['rev-parse', 'HEAD'])).stdout.trim(); }
  /**
   * Runs the project's test command on the current HEAD (30 minutes, Jevellan temp HOME, redacted output) and records the
   * receipt. It passes only with exit code 0, in time, and with HEAD unchanged: a run that moved HEAD did not test it.
   */
  async verify(project: Project, thread: Thread, ledger: ProjectLedger, signal?: AbortSignal): Promise<VerificationResult> {
    const cwd = thread.cwd; const attempt = thread.verificationAttempts + 1; const command = project.testCommand ?? null; const commit = await this.#head(cwd);
    let verified: VerificationResult;
    if (!command) verified = { status: 'skipped', command: null, timedOut: false, tail: '', commit };
    else {
      const result = await runThreadCommand(cwd, command, { homes: this.#homes, workId: thread.id, timeoutMs: this.#testTimeoutMs, redactor: this.#redactor, signal });
      const moved = await this.#head(cwd) !== commit;
      const notes = [...(result.timedOut ? [capitalized(commandTimedOut(this.#testTimeoutMs))] : []), ...(moved ? [VERIFICATION_HEAD_MOVED] : [])];
      const output = outputTail(result, Number.MAX_SAFE_INTEGER);
      const text = notes.length ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}${notes.join('\n')}` : output;
      const outputRef = ledger.putBlob({ stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }).ref;
      verified = { status: result.code === 0 && !result.timedOut && !moved ? 'passed' : 'failed', command, exitCode: result.code, timedOut: result.timedOut, tail: tail(text), outputRef, commit };
    }
    ledger.append({ type: 'thread-verification', data: { schema: 'thread-verification-v1', attempt, command: verified.command, status: verified.status,
      ...(verified.exitCode === undefined ? {} : { exitCode: verified.exitCode }), timedOut: verified.timedOut, commit: verified.commit,
      ...(verified.outputRef ? { outputRef: verified.outputRef } : {}), tail: verified.tail } });
    return verified;
  }
  /**
   * Pushes HEAD to the thread branch. The first push leases on "absent", so an existing remote branch is never clobbered;
   * later pushes lease on the last pushed commit. If a first push is refused because the branch holds one of this thread's
   * own commits (a push whose record was lost in a crash), it retries leasing on that commit.
   */
  async #push(cwd: string, thread: Thread, branch: string, pushed: string | undefined, signal?: AbortSignal): Promise<string> {
    const head = await this.#head(cwd);
    const push = (expected: string) => this.#git.run(cwd, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${expected}`, 'origin', `HEAD:refs/heads/${branch}`],
      { permitted: [1], timeoutMs: GIT_NETWORK_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    let result = await push(pushed ?? '');
    if (result.code !== 0 && !pushed) {
      const remote = (await this.#git.run(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`], { timeoutMs: GIT_NETWORK_TIMEOUT_MS, ...(signal ? { signal } : {}) })).stdout.split(/\s/)[0] ?? '';
      const own = remote ? (await this.#git.run(cwd, ['rev-list', `${thread.baseCommit}..HEAD`])).stdout.split('\n').includes(remote) : false;
      if (own) result = await push(remote);
    }
    if (result.code !== 0) {
      const rejected = result.stdout.split('\n').filter((line) => line.startsWith('!')).join('\n');
      throw new Error(`Git push failed (${result.code}): ${gitFailureMessage([result.stderr.trim(), rejected].filter(Boolean).join('\n'), this.#redactor)}`);
    }
    return head;
  }
  async publishWorktree(input: WorktreePublication): Promise<PublicationResult> {
    const { project, thread, local, ledger, signal } = input; const { cwd, branch } = thread;
    if (!cwd || !branch || !thread.baseCommit) throw new Error('The thread worktree is not ready.');
    let pushedCommit: string | undefined; let verified: VerificationResult | undefined;
    const result = (outcome: PublicationOutcome): PublicationResult => ({ outcome, ...(pushedCommit ? { pushedCommit } : {}), ...(verified ? { verified } : {}) });
    try {
      if ((await this.#git.run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout) {
        const identity = local.gitIdentity;
        await this.#git.run(cwd, ['add', '-A']);
        await this.#git.run(cwd, ['commit', '-m', leftoverCommitSubject(thread.title, thread.lastReport?.summary ?? thread.title)],
          identity ? { env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } } : {});
      }
      if (Number((await this.#git.run(cwd, ['rev-list', '--count', `${thread.baseCommit}..HEAD`])).stdout.trim()) === 0) return result({ kind: 'no-changes' });
      verified = await this.verify(project, thread, ledger, signal);
      if (verified.status === 'failed') return result({ kind: 'verification-failed', verification: verified });
      const remote = await this.#git.remoteUrl(cwd);
      if (remote === null) return result({ kind: 'no-remote', reason: NO_REMOTE });
      if (this.#redactor.text(remote) !== remote || /^https?:\/\/[^/]*@/i.test(remote)) return result({ kind: 'error', reason: REMOTE_CREDENTIALS });
      pushedCommit = await this.#push(cwd, thread, branch, local.pushedCommit, signal);
      input.onPushed?.(pushedCommit);
      const repository = parseGitHubRemote(remote);
      if (!repository) return result({ kind: 'branch-only', reason: NOT_GITHUB, branch });
      const token = await this.#github.token();
      if (!token) return result({ kind: 'branch-only', reason: BRANCH_PUSHED_NO_TOKEN, branch });
      const client = this.#github.client(token);
      try {
        const open = await client.findOpenPull(repository, branch);
        // List items carry no merge state; the single pull does.
        const pull = open ? await client.getPull(repository, open.number) : await client.createPull(repository, { title: thread.title, head: branch, base: thread.baseBranch,
          body: pullRequestBody({ summary: thread.lastReport?.summary ?? thread.title, testCommand: verified.status === 'passed' ? verified.command : null, title: thread.title,
            runtime: input.labels.runtimeName, modelLabel: input.labels.modelLabel, effort: thread.placement.effortEffective, deviceName: this.#deviceName }) });
        // Checks that cannot be read yet stay pending; the next poll reads them.
        const checks = await client.checks(repository, pull.headSha).catch((error: unknown) => { if (error instanceof GitHubError) return 'pending' as const; throw error; });
        return result({ kind: 'pr', result: open ? 'pr-updated' : 'pr-opened', pr: pullRequestState(pull, checks, new Date(this.#now()).toISOString()) });
      } catch (error) {
        if (error instanceof GitHubError) return result({ kind: 'error', reason: githubRefused(error.message).slice(0, 400) });
        throw error;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return result({ kind: 'error', reason: reasonOf(error, this.#redactor) });
    }
  }
}
