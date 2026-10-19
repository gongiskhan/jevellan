import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { IdSchema, inside, liveWork, resolvedPath, type CleanupItem, type Homes, type Project, type ProjectHub, type Thread, type ThreadLocal } from '@jevellan/core';
import type { ThreadGit } from './git.js';
import { parseWorktrees } from './worktree.js';

/** Only receipt-owned isolated paths enter the cleanup policy. Missing proof keeps the files. */
export class ProjectCleanupInventory {
  constructor(readonly o: { homes: Homes; deviceId: string; git: ThreadGit; hub: ProjectHub; projects(): Promise<Project[]>;
    threads(): Thread[]; thread(id: string): Thread | undefined; local(id: string): ThreadLocal; activePaths(): Promise<string[]> }) {}
  async items(): Promise<CleanupItem[]> {
    const items: CleanupItem[] = [], projects = await this.o.projects(), active = await this.o.activePaths();
    const registered = (path: string) => projects.some(project => { const repo = project.paths[this.o.deviceId]; return !!repo && inside(path, resolvedPath(repo)); });
    const idle = (path: string) => !registered(path) && !active.some(cwd => inside(path, resolvedPath(cwd)));
    const threadIdle = (thread: Thread) => !liveWork(thread.state) && thread.state !== 'attached' && thread.state !== 'queued' && !thread.queuedMessages.length && !this.o.local(thread.id).process;
    const treeClean = async (path: string) => !(await this.o.git.run(path, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const removeTree = async (project: Project, path: string) => {
      const repo = project.paths[this.o.deviceId]; if (!repo) throw new Error('Project checkout is unavailable.');
      const registered = parseWorktrees((await this.o.git.run(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout).filter(entry => inside(path, entry.path)).sort((a, b) => b.path.length - a.path.length);
      for (const tree of registered) await this.o.git.run(repo, ['worktree', 'remove', '--force', tree.path]);
      if (existsSync(path)) rmSync(path, { recursive: true });
    };
    for (const thread of this.o.threads()) {
      const expected = join(this.o.homes.root, 'worktrees', thread.projectId, thread.id);
      if (!thread.cwd || thread.cwd !== expected || resolvedPath(expected) !== expected || !existsSync(expected)) continue;
      const project = projects.find(project => project.id === thread.projectId);
      const ended = thread.resolution?.at ?? thread.landing?.at;
      const valid = !!project?.paths[this.o.deviceId] && !!ended && threadIdle(thread) && idle(expected);
      const clean = valid && await treeClean(expected);
      const unchanged = () => { const current = this.o.thread(thread.id); return !!current && threadIdle(current) && (current.resolution?.at ?? current.landing?.at) === ended; };
      items.push({ category: 'worktrees', path: expected, since: ended ?? thread.createdAt,
        ...(!valid || !clean ? { protected: !ended ? 'Thread has not landed and is not resolved.' : !valid ? 'Thread or checkout is active or unavailable.' : 'Thread has uncommitted files.' } : {}),
        verify: async () => unchanged() && (await this.o.activePaths()).every(cwd => !inside(expected, resolvedPath(cwd))) && await treeClean(expected),
        remove: () => removeTree(project!, expected) });
      // A removable whole worktree includes its evidence. Avoid overlapping deletions and double counting.
      if (valid && clean) continue;
      for (const folder of ['evidence', 'screenshots', 'test-results', '.jevellan/evidence', '.jevellan/screenshots']) {
        const path = join(expected, folder); if (!existsSync(path) || resolvedPath(path) !== path || !lstatSync(path).isDirectory()) continue;
        const tracked = (await this.o.git.run(expected, ['--literal-pathspecs', 'ls-files', '-z', '--', folder])).stdout;
        items.push({ category: 'evidence', path, since: new Date(lstatSync(path).mtimeMs).toISOString(),
          ...(!threadIdle(thread) || !idle(path) || tracked ? { protected: 'Active work or tracked project files.' } : {}),
          verify: async () => { const current = this.o.thread(thread.id); return !!current && threadIdle(current) && !(await this.o.git.run(expected, ['--literal-pathspecs', 'ls-files', '-z', '--', folder])).stdout; } });
      }
    }
    for (const project of projects) {
      const runs = []; let after: string | undefined;
      do { const page = await this.o.hub.jobRuns(project.id, after); runs.push(...page.records); after = page.next ?? undefined; } while (after);
      for (const run of runs.filter(run => run.deviceId === this.o.deviceId)) {
        const ended = run.endedAt ?? run.startedAt;
        const process = () => existsSync(join(this.o.homes.root, 'project-work', project.id, 'job-processes', `${run.id}.json`));
        const verify = async () => { const current = (await this.o.hub.jobRun(run.id))?.document; return !!current?.conclusion && current.endedAt === run.endedAt && !process(); };
        for (const path of [join(this.o.homes.root, 'project-work', project.id, 'job-workspaces', run.id), join(this.o.homes.root, 'worktrees', project.id, 'jobs', run.id)]) {
          if (!existsSync(path)) continue;
          items.push({ category: 'workspaces', path, since: ended, ...(!run.conclusion || process() || !idle(path) ? { protected: 'Job is running or its workspace is in use.' } : {}),
            verify: async () => await verify() && (await this.o.activePaths()).every(cwd => !inside(path, resolvedPath(cwd))), remove: () => removeTree(project, path) });
        }
        const log = join(this.o.homes.root, 'project-work', project.id, 'job-logs', `${run.id}.json`);
        if (existsSync(log)) items.push({ category: 'logs', path: log, since: ended, ...(!run.conclusion || process() ? { protected: 'Job is running.' } : {}), verify });
      }
    }
    const logs = join(this.o.homes.root, 'logs');
    if (existsSync(logs) && resolvedPath(logs) === logs) for (const name of readdirSync(logs)) {
      const path = join(logs, name); if (!lstatSync(path).isFile() || resolvedPath(path) !== path || !/\.log(?:\.[A-Za-z0-9_-]+)?$/u.test(name)) continue;
      items.push({ category: 'logs', path, since: new Date(lstatSync(path).mtimeMs).toISOString(), verify: () => true });
    }
    // Standalone evidence directories never include ledger or native transcript files.
    for (const thread of this.o.threads()) for (const folder of ['evidence', 'screenshots']) {
      const path = join(this.o.homes.root, 'projects', IdSchema.parse(thread.projectId), 'threads', IdSchema.parse(thread.id), folder);
      if (!existsSync(path)) continue;
      items.push({ category: 'evidence', path, since: new Date(lstatSync(path).mtimeMs).toISOString(), ...(!threadIdle(thread) || !idle(path) ? { protected: 'Thread is running.' } : {}),
        verify: () => { const current = this.o.thread(thread.id); return !!current && threadIdle(current); } });
    }
    return items;
  }
}
