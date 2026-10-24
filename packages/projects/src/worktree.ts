import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { ProjectRelativePathSchema, inside, resolveProjectPath, resolvedPath, threadBranch, type Homes, type Project, type SecretRedactor, type Thread } from '@jevellan/core';
import { ProjectContext } from '@jevellan/memory';
import { commandTimedOut, contextLinkSkipped, contextUnreadable, exitCodeLine, skippedCopyFile, unsafeCopyFile, worktreeSetupFailed } from './copy.js';
import { THREAD_REF_PREFIX, firstLine, threadBaseRef, threadPullHeadRef, type ThreadGit } from './git.js';
import type { ProjectLedger } from './ledger.js';
import type { ProjectPaths } from './paths.js';
import { SETUP_TIMEOUT_MS, runThreadCommand } from './verification.js';

export type WorktreeEntry = { path: string; head?: string; branch?: string; prunable: boolean };
/** What `syncPullHead` did before a fix turn: nothing, moved the branch to (or merged) the pull request head, or left a conflicted merge. */
export type PullHeadSync = { kind: 'current' } | { kind: 'updated'; head: string } | { kind: 'conflict'; head: string; files: string[] };
/** `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends each entry. */
export function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []; let current: WorktreeEntry | undefined;
  for (const field of output.split('\0')) {
    if (!field) { if (current) entries.push(current); current = undefined; continue; }
    const space = field.indexOf(' '); const key = space < 0 ? field : field.slice(0, space); const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') { if (current) entries.push(current); current = { path: value, prunable: false }; }
    else if (current && key === 'HEAD') current.head = value;
    else if (current && key === 'branch') current.branch = value;
    else if (current && key === 'prunable') current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
}
const present = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
const isFile = (path: string) => { try { return lstatSync(path).isFile(); } catch { return false; } };
export type PreparedWorktree = { cwd: string; branch: string; baseBranch: string; baseCommit: string; contextNote?: string };
export type SetupResult = { ok: true; outputRef: string } | { ok: false; reason: string; outputRef: string; timedOut: boolean };

/**
 * A thread's own git worktree under `<home>/worktrees/<pid>/<tid>` (brief 8.3). Git runs in the owner checkout only to
 * change `.git` metadata and refs; the checkout's files, HEAD and index are never touched, and nothing is ever deleted
 * on the remote.
 */
export class ThreadWorktree {
  readonly #git: ThreadGit; readonly #homes: Homes; readonly #paths: ProjectPaths; readonly #redactor: SecretRedactor;
  readonly #validateBranch: ((project: Project, branch: string) => Promise<void>) | undefined;
  readonly #deviceId: string; readonly #deviceName: string;
  readonly #projectEnvironment: ((projectId: string) => Promise<Record<string, string>>) | undefined;
  constructor(o: { validateBranch?(project: Project, branch: string): Promise<void>; projectEnvironment?(projectId: string): Promise<Record<string, string>>; git: ThreadGit; homes: Homes; paths: ProjectPaths; redactor: SecretRedactor; deviceId: string; deviceName: string }) {
    this.#validateBranch = o.validateBranch; this.#projectEnvironment = o.projectEnvironment; this.#git = o.git; this.#homes = o.homes; this.#paths = o.paths; this.#redactor = o.redactor; this.#deviceId = o.deviceId; this.#deviceName = o.deviceName;
  }
  /** The project checkout on this device (brief 8.3 repository). */
  repository(project: Project): string { return resolveProjectPath(project, this.#deviceId, this.#deviceName); }
  /** `origin/HEAD` without `origin/`, else `main`. */
  async baseBranch(repo: string): Promise<string> {
    const head = (await this.#git.run(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { permitted: [1, 128] })).stdout.trim();
    return head.startsWith('origin/') && head.length > 'origin/'.length ? head.slice('origin/'.length) : 'main';
  }
  async #entry(repo: string, path: string): Promise<WorktreeEntry | undefined> {
    const target = resolvedPath(path);
    return parseWorktrees((await this.#git.run(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout).find((entry) => resolvedPath(entry.path) === target);
  }
  /** Without an origin the base is the local base branch, else the checked-out branch, and the branch stays local. */
  async #localBase(repo: string): Promise<{ baseBranch: string; ref: string }> {
    const detected = await this.baseBranch(repo);
    if (await this.#git.resolve(repo, `refs/heads/${detected}`)) return { baseBranch: detected, ref: `refs/heads/${detected}` };
    const current = (await this.#git.run(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { permitted: [1, 128] })).stdout.trim();
    return current ? { baseBranch: current, ref: `refs/heads/${current}` } : { baseBranch: detected, ref: 'HEAD' };
  }
  /** Fetches (or, without an origin, records) the private base ref `refs/jevellan/threads/<tid>/base` (D14). */
  async #base(repo: string, threadId: string, signal?: AbortSignal): Promise<{ baseBranch: string; baseCommit: string }> {
    const ref = threadBaseRef(threadId);
    if (await this.#git.remoteUrl(repo) !== null) {
      const baseBranch = await this.baseBranch(repo);
      return { baseBranch, baseCommit: await this.#git.fetchPrivate(repo, baseBranch, ref, signal) };
    }
    const local = await this.#localBase(repo); const baseCommit = await this.#git.resolve(repo, local.ref);
    if (!baseCommit) throw new Error('The project checkout has no commit to start a thread from.');
    await this.#git.run(repo, ['update-ref', ref, baseCommit, '']);
    return { baseBranch: local.baseBranch, baseCommit };
  }
  /**
   * Idempotent, so a restart during `preparing` can run it again (D67, D144): a registered worktree on the thread branch
   * is reused without fetching, and the base always comes from the private base ref, never from HEAD.
   */
  async create(project: Project, thread: Thread, signal?: AbortSignal): Promise<PreparedWorktree> {
    const repo = this.repository(project); const path = this.#paths.worktree(thread.projectId, thread.id);
    const branch = thread.branch ?? threadBranch(thread.title, thread.id); const ref = threadBaseRef(thread.id);
    await this.#git.run(repo, ['check-ref-format', '--branch', branch]);
    let entry = await this.#entry(repo, path);
    if (entry && (entry.prunable || !existsSync(path))) { await this.#forget(repo, path); entry = undefined; }
    if (entry && entry.branch !== `refs/heads/${branch}`) throw new Error('The thread worktree is on another branch.');
    let baseCommit = await this.#git.resolve(repo, ref) ?? (thread.baseCommit || null);
    let baseBranch = thread.baseBranch;
    if (!baseCommit) ({ baseBranch, baseCommit } = await this.#base(repo, thread.id, signal));
    if (!baseBranch) baseBranch = await this.#git.remoteUrl(repo) !== null ? await this.baseBranch(repo) : (await this.#localBase(repo)).baseBranch;
    if (!entry) {
      // An unregistered folder here is a leftover of an interrupted `worktree add` inside Jevellan's own home.
      if (present(path)) rmSync(path, { recursive: true, force: true });
      this.#paths.worktreeParent(thread.projectId);
      const exists = await this.#git.resolve(repo, `refs/heads/${branch}`);
      let start = baseCommit;
      if (!exists && thread.fromBranch) {
        await this.#validateBranch?.(project, thread.fromBranch);
        start = await this.#git.fetchPrivate(repo, thread.fromBranch, `${THREAD_REF_PREFIX}${thread.id}/from-branch`, signal);
      }
      await this.#git.run(repo, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '--no-track', '-b', branch, path, start], { ...(signal ? { signal } : {}) });
    }
    const contextNote = await this.#links(project, path);
    return { cwd: path, branch, baseBranch, baseCommit, ...(contextNote ? { contextNote } : {}) };
  }
  /**
   * Mirrors the owner checkout's untracked AGENTS.md/CLAUDE.md link into the worktree only when git ignores it there
   * (the common info/exclude), so `git add -A` cannot commit it (D26). The owner checkout is inspected read-only.
   */
  async #links(project: Project, cwd: string): Promise<string | undefined> {
    let files;
    try { files = new ProjectContext(project, this.#deviceId, () => { throw new Error('Context inspection cannot change files.'); }).inspect().files; }
    catch (error) { return contextUnreadable(this.#redactor.text(error instanceof Error ? error.message : String(error))); }
    const notes: string[] = [];
    for (const file of files) {
      if (file.kind !== 'link' || file.tracked || !file.target || present(join(cwd, file.name))) continue;
      const ignored = (await this.#git.run(cwd, ['check-ignore', '-q', '--', file.name], { permitted: [1] })).code === 0;
      if (ignored && isFile(join(cwd, file.target))) symlinkSync(file.target, join(cwd, file.name));
      else notes.push(contextLinkSkipped(file.name));
    }
    return notes.length ? notes.join(' ') : undefined;
  }
  /** Copy only owner-selected untracked regular files, without following any source or destination links. */
  async copyFiles(project: Project, thread: Thread, paths: string[], ledger: ProjectLedger): Promise<string[]> {
    const root = this.repository(project), copied: string[] = [];
    for (const raw of paths) {
      const path = ProjectRelativePathSchema.parse(raw), source = join(root, path), target = join(thread.cwd, path);
      if (!inside(root, source) || !inside(thread.cwd, target)) throw new Error(unsafeCopyFile(path));
      for (const base of [root, thread.cwd]) {
        let current = base;
        for (const part of path.split('/')) { current = join(current, part); if (present(current) && lstatSync(current).isSymbolicLink()) throw new Error(unsafeCopyFile(path)); }
      }
      const tracked = (await this.#git.run(thread.cwd, ['--literal-pathspecs', 'ls-tree', '-z', thread.baseCommit, '--', path])).stdout.length > 0;
      const missing = !existsSync(source);
      if (tracked || missing) { ledger.append({ type: 'notice', data: { schema: 'project-notice-v1', kind: 'info', text: skippedCopyFile(path, tracked ? undefined : this.#deviceName) } }); continue; }
      const stat = lstatSync(source); if (!stat.isFile()) throw new Error(unsafeCopyFile(path));
      if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target); chmodSync(target, stat.mode & 0o777); }
      copied.push(path);
    }
    return copied;
  }
  /** The project's setup command in the worktree (15 minutes); the output is a blob in the thread ledger. */
  async setup(thread: Thread, command: string, ledger: ProjectLedger, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SetupResult> {
    if (!thread.cwd || !isAbsolute(thread.cwd)) throw new Error('The thread worktree is not ready.');
    const timeoutMs = o.timeoutMs ?? SETUP_TIMEOUT_MS;
    const result = await runThreadCommand(thread.cwd, command, { homes: this.#homes, workId: thread.id, timeoutMs, redactor: this.#redactor, projectEnv: await this.#projectEnvironment?.(thread.projectId) ?? {}, signal: o.signal });
    const outputRef = ledger.putBlob({ stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }).ref;
    if (result.code === 0 && !result.timedOut) return { ok: true, outputRef };
    const line = result.timedOut ? commandTimedOut(timeoutMs) : firstLine(result.stderr) || firstLine(result.stdout) || exitCodeLine(result.code);
    return { ok: false, reason: worktreeSetupFailed(line), outputRef, timedOut: result.timedOut };
  }
  /**
   * Before a fix turn (fix-051): fetches the pull request's current head into the thread's private ref space. A head ahead of the
   * worktree branch is fast-forwarded when the branch has nothing unpushed, and merged (never rebased) when both sides have commits;
   * a merge that conflicts is left in progress for the turn to resolve.
   */
  async syncPullHead(project: Project, thread: Thread, signal?: AbortSignal): Promise<PullHeadSync> {
    if (thread.isolation !== 'worktree' || !thread.cwd || thread.pr?.state !== 'open') return { kind: 'current' };
    const repo = this.repository(project), cwd = thread.cwd, n = thread.pr.number;
    const head = await this.#git.fetchPullHead(repo, n, threadPullHeadRef(thread.id), signal);
    const count = async (range: string) => Number((await this.#git.run(cwd, ['rev-list', '--count', range])).stdout.trim());
    if (await this.#git.resolve(cwd, 'MERGE_HEAD') === head) return { kind: 'conflict', head, files: await this.#unmerged(cwd) };
    if (!await count(`HEAD..${head}`)) return { kind: 'current' };
    if (!await count(`${head}..HEAD`)) { await this.#git.run(cwd, ['merge', '--ff-only', head]); return { kind: 'updated', head }; }
    const identity = await this.#git.identity(repo);
    const merged = await this.#git.run(cwd, ['merge', '--no-ff', '--no-edit', '-m', `Merge pull request #${n}'s head ${head.slice(0, 7)}`, head], { permitted: [1],
      ...(identity ? { env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } } : {}) });
    if (merged.code === 0) return { kind: 'updated', head };
    const files = await this.#unmerged(cwd);
    if (!files.length) throw new Error(`Git merge failed: ${merged.stderr.trim().slice(0, 500)}`);
    return { kind: 'conflict', head, files };
  }
  async #unmerged(cwd: string): Promise<string[]> {
    return (await this.#git.run(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 200);
  }
  async hasCommits(thread: Thread): Promise<boolean> {
    if (!thread.cwd || !thread.baseCommit || !existsSync(thread.cwd)) return false;
    return Number((await this.#git.run(thread.cwd, ['rev-list', '--count', `${thread.baseCommit}..HEAD`])).stdout.trim()) > 0;
  }
  /** Fresh index facts for one project's worktrees; the publish action still checks its current HEAD with `hasCommits`. */
  async indexCommits(threads: readonly Thread[]): Promise<Map<string, boolean>> {
    const first = threads.find(thread => thread.cwd && thread.baseCommit && existsSync(thread.cwd));
    let entries: WorktreeEntry[] = [];
    if (first) {
      try { entries = parseWorktrees((await this.#git.run(first.cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout); }
      catch { /* The caller retains each thread's normal query when no snapshot fact is available. */ }
    }
    const registered = new Map(entries.map(entry => [resolvedPath(entry.path), entry]));
    const result = new Map<string, boolean>();
    const groups = new Map<string, Array<{ thread: Thread; entry: WorktreeEntry }>>();
    for (const thread of threads) {
      // Equal immutable commit ids have an empty range, including after a reset. No fact survives this poll.
      const entry = thread.cwd ? registered.get(resolvedPath(thread.cwd)) : undefined;
      if (thread.baseCommit && entry?.head === thread.baseCommit) { result.set(thread.id, false); continue; }
      if (!entry?.head || !entry.branch?.startsWith('refs/heads/') || entry.prunable || !existsSync(thread.cwd) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(thread.baseCommit)) continue;
      const group = groups.get(thread.baseCommit) ?? []; group.push({ thread, entry }); groups.set(thread.baseCommit, group);
    }
    for (const [base, group] of groups) {
      if (group.length < 2) continue;
      try {
        // Git computes all ranges sharing a base in one graph traversal. Unsupported Git retains the normal per-thread query.
        const refs = [...new Set(group.map(row => row.entry.branch!))];
        const output = await this.#git.run(group[0]!.thread.cwd, ['for-each-ref', `--format=%(refname)%09%(objectname)%09%(ahead-behind:${base})`, ...refs]);
        const facts = new Map<string, { head: string; ahead: number }>();
        for (const line of output.stdout.split('\n').filter(Boolean)) {
          const [ref, head, counts] = line.split('\t');
          if (!ref || !head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head) || !/^\d+ \d+$/u.test(counts ?? '')) continue;
          const ahead = Number(counts!.split(' ')[0]); if (Number.isSafeInteger(ahead)) facts.set(ref, { head, ahead });
        }
        for (const { thread, entry } of group) {
          const fact = facts.get(entry.branch!);
          // A ref moved between the worktree snapshot and this query: leave it to the caller's fresh fallback.
          if (fact && fact.head === entry.head) result.set(thread.id, fact.ahead > 0);
        }
      } catch { /* No optimistic fact on unavailable capability, invalid refs, a moved checkout or a repository error. */ }
    }
    return result;
  }
  async exists(project: Project, thread: Thread): Promise<boolean> {
    const path = this.#paths.worktree(thread.projectId, thread.id); const entry = await this.#entry(this.repository(project), path);
    return !!entry && !entry.prunable && existsSync(path) && entry.branch === `refs/heads/${thread.branch ?? threadBranch(thread.title, thread.id)}`;
  }
  /**
   * Forgets the registration of this thread's worktree, and only that one (P8 review TH-3): its folder (inside Jevellan's home) goes
   * first, then `worktree remove --force` drops the entry of a missing folder. A repository-wide `worktree prune` would also drop the
   * owner's own worktrees whose folders are away for now.
   */
  async #forget(repo: string, path: string): Promise<void> {
    if (present(path)) rmSync(path, { recursive: true, force: true });
    await this.#git.run(repo, ['worktree', 'remove', '--force', path]);
  }
  /**
   * Cleanup on merge, close and explicit discard: `worktree remove --force` (also when the folder vanished,
   * for that one entry), `branch -D` for the local `jv/` branch, and the private thread refs. Remote branches stay.
   */
  async remove(project: Project, thread: Thread): Promise<void> {
    const repo = this.repository(project); const path = this.#paths.worktree(thread.projectId, thread.id);
    const entry = await this.#entry(repo, path);
    if (entry && existsSync(path)) await this.#git.run(repo, ['worktree', 'remove', '--force', path]);
    else if (entry) await this.#forget(repo, path);
    if (present(path)) rmSync(path, { recursive: true, force: true });
    const branch = thread.branch ?? threadBranch(thread.title, thread.id);
    if (branch.startsWith('jv/') && await this.#git.resolve(repo, `refs/heads/${branch}`)) await this.#git.run(repo, ['branch', '-D', branch]);
    const refs = (await this.#git.run(repo, ['for-each-ref', '--format=%(refname)', `${THREAD_REF_PREFIX}${thread.id}`])).stdout.split('\n').filter(Boolean);
    for (const ref of refs) await this.#git.run(repo, ['update-ref', '-d', ref]);
  }
}
