import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ContextOperationSchema, IdSchema, readDocument, stableJson, writeDocument, type ContextOperation, type Homes } from '@jevellan/core';

/** Context drafts and file contents belong to the owning daemon, not the hub. */
export class ContextOperations {
  constructor(readonly homes: Homes) {}
  #path(id: string) {
    const path = this.homes.at('context-operations', `${IdSchema.parse(id)}.json`);
    if (path !== join(this.homes.root, 'context-operations', `${id}.json`)) throw new Error('Context operation files cannot alias another location.');
    return path;
  }
  get(id: string): ContextOperation | null {
    const path = this.#path(id); if (!existsSync(path)) return null;
    const record = readDocument(path, ContextOperationSchema);
    if (record.id !== id) throw new Error('Context operation identifier does not match its file.');
    return record;
  }
  list(): ContextOperation[] {
    const directory = this.homes.at('context-operations'); if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith('.json')).map(name => this.get(name.slice(0, -5))!);
  }
  put(raw: ContextOperation): void {
    const value = ContextOperationSchema.parse(raw); const previous = this.get(value.id);
    if (previous && (previous.conversationId !== value.conversationId || previous.projectId !== value.projectId || previous.workId !== value.workId)) throw new Error('This context operation belongs to different work.');
    if (!previous || stableJson(previous) !== stableJson(value)) writeDocument(this.#path(value.id), ContextOperationSchema, value);
  }
}
