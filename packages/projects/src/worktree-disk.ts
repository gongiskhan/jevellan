import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { IdSchema, ThreadLocalSchema, CoordinatorLocalSchema, WorktreeCleanupInputSchema, WorktreeDiskSchema, inside, readDocument, resolvedPath, runOwnedCommand, stableJson, type Homes, type Project, type WorktreeDiskEntry } from '@jevellan/core';
import type { ThreadGit } from './git.js';
import { parseWorktrees } from './worktree.js';
const WEEK = 7 * 24 * 60 * 60_000;
const folders = { thread: '', job: 'jobs', verification: 'pr-verification', review: 'nightly-reviews' } as const;
type Ownership = { project: Project; repository: string; retained: Set<string> };
const fail = (message: string) => Object.assign(new Error(message), { status: 409 });
/** Only Jevellan-owned paths are inspected. Symlinks are counted, never followed. */
function inspect(path: string) {
  const hash = createHash('sha256'); let bytes = 0, updated = 0;
  const walk = (current: string) => {
    const stat = lstatSync(current); updated = Math.max(updated, stat.mtimeMs, stat.ctimeMs); bytes += (stat.blocks ?? 0) * 512;
    hash.update(stableJson([current.slice(path.length), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (stat.isDirectory()) for (const name of readdirSync(current).sort()) walk(join(current, name));
  };
  walk(path); return { bytes, updated, fingerprint: hash.digest('hex') };
}
/** Cleanup is called with the daemon's exclusive maintenance lock, so no admitted work can start between recheck and removal. */
export class WorktreeDiskService {
  constructor(readonly o: { homes: Homes; git: ThreadGit; deviceId: string; ownership(): Promise<Ownership[]>; now?(): number; activePaths?(): Promise<string[]> }) {}
  async activePaths() {
    if (this.o.activePaths) return this.o.activePaths();
    // Read cwd only, never process arguments or environments. A failed probe cannot prove a tree idle.
    const result = await runOwnedCommand('lsof', ['-F', 'pn', '-d', 'cwd'], { cwd: this.o.homes.root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin' }, timeoutMs: 10_000, outputLimitBytes: 8 * 1024 * 1024 });
    if (result.code !== 0 || result.timedOut) throw fail('Active worktree processes could not be checked. Try cleanup after device recovery.');
    return result.stdout.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
  }
  #root(projectId: string) { return join(this.o.homes.root, 'worktrees', projectId); }
  #path(row: Pick<WorktreeDiskEntry, 'projectId' | 'id' | 'kind'>) {
    const path = join(this.#root(row.projectId), folders[row.kind], row.id);
    if (resolvedPath(path) !== path || !inside(join(this.o.homes.root, 'worktrees'), path)) throw fail('Worktree paths cannot alias another location.');
    return path;
  }
  #processReceipts(projectId: string): boolean {
    const walk = (path: string): boolean => {
      if (resolvedPath(path) !== path) return true;
      const stat = lstatSync(path);
      if (!stat.isDirectory()) {
        const name = path.split('/').at(-1)!;
        if (name === 'thread-local.json') return !!readDocument(path, ThreadLocalSchema).process;
        if (name === 'coordinator-local.json') return !!readDocument(path, CoordinatorLocalSchema).process;
        return /(?:process|native).*\.json$/u.test(name);
      }
      return readdirSync(path).some(name => /(?:job|review|verification)-processes$/u.test(name)
        ? readdirSync(join(path, name)).length > 0 : walk(join(path, name)));
    };
    return ['project-work', 'projects'].some(folder => {
      const root = join(this.o.homes.root, folder, projectId); return existsSync(root) && walk(root);
    });
  }
  async read() {
    const now = this.o.now?.() ?? Date.now(), owners = await this.o.ownership(); const byProject = new Map(owners.map(owner => [owner.project.id, owner]));
    const entries: WorktreeDiskEntry[] = [], root = join(this.o.homes.root, 'worktrees');
    if (existsSync(root)) {
      if (resolvedPath(root) !== root) throw fail('Worktree paths cannot alias another location.');
      for (const projectId of readdirSync(root).filter(id => IdSchema.safeParse(id).success)) {
        const parent = this.#root(projectId); if (resolvedPath(parent) !== parent || !lstatSync(parent).isDirectory()) continue;
        const owner = byProject.get(projectId), receipts = this.#processReceipts(projectId);
        for (const [kind, folder] of Object.entries(folders) as Array<[WorktreeDiskEntry['kind'], string]>) {
          const directory = join(parent, folder); if (!existsSync(directory) || resolvedPath(directory) !== directory || !lstatSync(directory).isDirectory()) continue;
          for (const id of readdirSync(directory).filter(id => IdSchema.safeParse(id).success && !(kind === 'thread' && Object.values(folders).includes(id as typeof folders[keyof typeof folders])))) {
            const row = { projectId, id, kind }, path = this.#path(row); if (!lstatSync(path).isDirectory()) continue;
            const data = inspect(path);
            const reason = owners.some(owner => inside(path, resolvedPath(owner.repository))) ? 'Registered project checkout.'
              : !owner ? 'Project checkout is unavailable.' : owner.retained.has(`${kind}:${id}`) ? 'Retained by a work receipt.'
              : receipts ? 'Process receipts need recovery before cleanup.' : now - data.updated < WEEK ? 'Less than seven days old.' : undefined;
            entries.push({ ...row, bytes: data.bytes, updatedAt: new Date(data.updated).toISOString(), fingerprint: data.fingerprint, orphan: !reason, ...(reason ? { reason } : {}) });
          }
        }
      }
    }
    return WorktreeDiskSchema.parse({ schema: 'worktree-disk-v1', deviceId: this.o.deviceId, at: new Date(now).toISOString(), entries,
      threadBytes: entries.filter(row => row.kind === 'thread').reduce((n, row) => n + row.bytes, 0), jobBytes: entries.filter(row => row.kind !== 'thread').reduce((n, row) => n + row.bytes, 0) });
  }
  async cleanup(raw: unknown) {
    const input = WorktreeCleanupInputSchema.parse(raw), current = await this.read();
    const selected = input.entries.map(entry => {
      const row = current.entries.find(row => row.projectId === entry.projectId && row.id === entry.id && row.kind === entry.kind);
      if (!row?.orphan || row.fingerprint !== entry.fingerprint) throw fail('The worktree changed or is retained by work. Inspect again before removing it.');
      return row;
    });
    const owners = await this.o.ownership();
    const active = await this.activePaths();
    for (const row of selected) {
      const owner = owners.find(owner => owner.project.id === row.projectId);
      if (!owner || owner.retained.has(`${row.kind}:${row.id}`) || this.#processReceipts(row.projectId)) throw fail('Work now retains this worktree. Inspect again before removing it.');
      const path = this.#path(row); if (inspect(path).fingerprint !== row.fingerprint) throw fail('The worktree changed. Inspect again before removing it.');
      if (owners.some(owner => inside(path, resolvedPath(owner.repository)))) throw fail('This folder is a registered project checkout.');
      if (active.some(cwd => inside(path, resolvedPath(cwd)))) throw fail('A process is using this worktree. Finish it before cleanup.');
      const registered = parseWorktrees((await this.o.git.run(owner.repository, ['worktree', 'list', '--porcelain', '-z'])).stdout).find(entry => entry.path === path);
      if (registered) await this.o.git.run(owner.repository, ['worktree', 'remove', '--force', path]);
      else rmSync(path, { recursive: true });
    }
    return this.read();
  }
}
