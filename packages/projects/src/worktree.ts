import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveProjectPath, resolvedPath, threadBranch, type Homes, type Project, type SecretRedactor, type Thread } from '@jevellan/core';
import { ProjectContext } from '@jevellan/memory';
import { commandTimedOut, contextLinkSkipped, contextUnreadable, exitCodeLine, worktreeSetupFailed } from './copy.js';
import { THREAD_REF_PREFIX, firstLine, threadBaseRef, type ThreadGit } from './git.js';
import type { ProjectLedger } from './ledger.js';
import type { ProjectPaths } from './paths.js';
import { SETUP_TIMEOUT_MS, runThreadCommand } from './verification.js';

export type WorktreeEntry = { path: string; head?: string; branch?: string; prunable: boolean };
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
export type SetupResult = { ok: true; outputRef: string } | { ok: false; reason: string; outputRef: string };

/**
 * A thread's own git worktree under `<home>/worktrees/<pid>/<tid>` (brief 8.3). Git runs in the owner checkout only to
 * change `.git` metadata and refs; the checkout's files, HEAD and index are never touched, and nothing is ever deleted
 * on the remote.
 */
export class ThreadWorktree {
  readonly #git: ThreadGit; readonly #homes: Homes; readonly #paths: ProjectPaths; readonly #redactor: SecretRedactor;
  readonly #deviceId: string; readonly #deviceName: string;
  constructor(o: { git: ThreadGit; homes: Homes; paths: ProjectPaths; redactor: SecretRedactor; deviceId: string; deviceName: string }) {
    this.#git = o.git; this.#homes = o.homes; this.#paths = o.paths; this.#redactor = o.redactor; this.#deviceId = o.deviceId; this.#deviceName = o.deviceName;
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
      await this.#git.run(repo, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '--no-track', '-b', branch, path, baseCommit], { ...(signal ? { signal } : {}) });
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
  /** The project's setup command in the worktree (15 minutes); the output is a blob in the thread ledger. */
  async setup(thread: Thread, command: string, ledger: ProjectLedger, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SetupResult> {
    if (!thread.cwd || !isAbsolute(thread.cwd)) throw new Error('The thread worktree is not ready.');
    const timeoutMs = o.timeoutMs ?? SETUP_TIMEOUT_MS;
    const result = await runThreadCommand(thread.cwd, command, { homes: this.#homes, workId: thread.id, timeoutMs, redactor: this.#redactor, signal: o.signal });
    const outputRef = ledger.putBlob({ stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }).ref;
    if (result.code === 0 && !result.timedOut) return { ok: true, outputRef };
    const line = result.timedOut ? commandTimedOut(timeoutMs) : firstLine(result.stderr) || firstLine(result.stdout) || exitCodeLine(result.code);
    return { ok: false, reason: worktreeSetupFailed(line), outputRef };
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
   * Cleanup on merge, close, discard and done without changes (brief 8.3): `worktree remove --force` (also when the folder vanished,
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
