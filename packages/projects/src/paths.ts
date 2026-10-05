import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IdSchema, type Homes } from '@jevellan/core';

/**
 * Owner-local Projects paths. Ids are validated before joining (`homes.at` only stops escapes from the root), and a
 * path that resolves elsewhere through a link is refused.
 */
export class ProjectPaths {
  constructor(readonly homes: Homes) {}
  #at(...parts: string[]): string {
    const path = this.homes.at(...parts);
    if (path !== join(this.homes.root, ...parts)) throw new Error('Project files cannot alias another location.');
    return path;
  }
  /** `<home>/projects/<pid>`: coordinator files and the coordinator ledger directory. */
  project(projectId: string): string { return this.#at('projects', IdSchema.parse(projectId)); }
  coordinator(projectId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'coordinator.json'); }
  coordinatorLocal(projectId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'coordinator-local.json'); }
  /** `<home>/projects/<pid>/threads/<tid>`: thread files and the thread ledger directory. */
  thread(projectId: string, threadId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'threads', IdSchema.parse(threadId)); }
  threadFile(projectId: string, threadId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'threads', IdSchema.parse(threadId), 'thread.json'); }
  threadLocal(projectId: string, threadId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'threads', IdSchema.parse(threadId), 'thread-local.json'); }
  /** `<home>/projects/<pid>/outbox`: one file per undelivered envelope, `<seq padded 12>-<envelopeId>.json`, and `seq.json`. */
  outbox(projectId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'outbox'); }
  outboxSeq(projectId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'outbox', 'seq.json'); }
  /** `<home>/projects/inbox-seen.json`: the envelope ids this device processed (2.6.15). */
  inboxSeen(): string { return this.#at('projects', 'inbox-seen.json'); }
  request(projectId: string, clientRequestId: string): string { return this.#at('projects', IdSchema.parse(projectId), 'requests', `${IdSchema.parse(clientRequestId)}.json`); }
  /** `<home>/worktrees/<pid>/<tid>`, outside every checkout. Only the parent is created; `git worktree add` creates the leaf. */
  worktree(projectId: string, threadId: string): string { return this.#at('worktrees', IdSchema.parse(projectId), IdSchema.parse(threadId)); }
  worktreeParent(projectId: string): string { return this.homes.ensure('worktrees', IdSchema.parse(projectId)); }
  #ids(path: string): string[] {
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && IdSchema.safeParse(entry.name).success).map((entry) => entry.name).sort();
  }
  /** Project directories on this device; names that are not ids are skipped. */
  projectIds(): string[] { return this.#ids(this.#at('projects')); }
  threadIds(projectId: string): string[] { return this.#ids(this.#at('projects', IdSchema.parse(projectId), 'threads')); }
}
