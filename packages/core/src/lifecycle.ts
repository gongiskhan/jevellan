import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { readDocument, writeDocument } from './files.js';
import type { Homes } from './homes.js';
import { IdSchema } from './schemas.js';

const ActivitySchema = z.strictObject({ kind: z.enum(['startup', 'request', 'conversation', 'settings']), id: IdSchema.optional(), title: z.string().max(512).optional() });
export const LifecycleActivitySchema = z.strictObject({ schema: z.literal('lifecycle-activity-v1'), at: z.iso.datetime(), activities: z.array(ActivitySchema) });
export type LifecycleActivity = z.infer<typeof ActivitySchema>;
export class MaintenanceBusy extends Error {
  readonly status = 503;
  constructor() { super('Jevellan is being updated or removed. Try again when installation finishes.'); }
}
function busy(error: unknown): boolean { return !!error && typeof error === 'object' && 'errcode' in error && typeof error.errcode === 'number' && [5, 6].includes(error.errcode & 255); }
function path(homes: Homes, name: string): string {
  const expected = join(homes.root, 'locks', name);
  if (homes.at('locks', name) !== expected) throw new Error('Lifecycle files cannot alias another location.');
  return expected;
}
export function lifecycleActivity(homes: Homes): LifecycleActivity[] {
  const file = path(homes, 'activity.json'); return existsSync(file) ? readDocument(file, LifecycleActivitySchema).activities : [];
}

/** Shared read transactions admit work; an exclusive transaction reserves an idle service switch. */
export class LifecycleGate {
  readonly #db: DatabaseSync;
  readonly #activities = new Map<string, LifecycleActivity>();
  #exclusive = false;
  #closed = false;
  constructor(readonly homes: Homes) {
    homes.ensure('locks'); const file = path(homes, 'lifecycle.db');
    try { writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    chmodSync(file, 0o600); this.#db = new DatabaseSync(file);
    try {
      this.#db.exec('PRAGMA busy_timeout=0;');
      if (this.#db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new Error('The lifecycle gate requires SQLite rollback-journal locking.');
      if (!this.#db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='gate'").get()) this.#db.exec('CREATE TABLE IF NOT EXISTS gate (id INTEGER PRIMARY KEY);');
    } catch (error) { this.#db.close(); if (busy(error)) throw new MaintenanceBusy(); throw error; }
  }
  #assert(): void { if (this.#closed) throw new Error('The lifecycle gate is closed.'); }
  #publish(): void { writeDocument(path(this.homes, 'activity.json'), LifecycleActivitySchema, { schema: 'lifecycle-activity-v1', at: new Date().toISOString(), activities: [...this.#activities.values()] }); }
  enter(input: LifecycleActivity): () => void {
    this.#assert(); const activity = ActivitySchema.parse(input);
    if (this.#exclusive) throw new MaintenanceBusy();
    if (!this.#activities.size) {
      this.#db.exec('BEGIN;');
      try { this.#db.prepare('SELECT id FROM gate').all(); }
      catch (error) { this.#db.exec('ROLLBACK'); if (busy(error)) throw new MaintenanceBusy(); throw error; }
    }
    const id = randomUUID(); this.#activities.set(id, activity);
    try { this.#publish(); }
    catch (error) { this.#activities.delete(id); if (!this.#activities.size) this.#db.exec('ROLLBACK'); throw error; }
    let released = false;
    return () => {
      if (released) return; released = true; this.#activities.delete(id);
      try { this.#publish(); }
      finally { if (!this.#activities.size) this.#db.exec('ROLLBACK'); }
    };
  }
  tryMaintenance(): (() => void) | null {
    this.#assert(); if (this.#activities.size) return null;
    if (this.#exclusive) throw new Error('This installer already holds the lifecycle gate.');
    try { this.#db.exec('BEGIN EXCLUSIVE;'); }
    catch (error) { if (busy(error)) return null; throw error; }
    this.#exclusive = true; let released = false;
    return () => { if (released) return; released = true; try { this.#db.exec('ROLLBACK'); } finally { this.#exclusive = false; } };
  }
  close(): void {
    if (this.#closed) return;
    if (this.#activities.size || this.#exclusive) throw new Error('Release active work or maintenance before closing the lifecycle gate.');
    this.#closed = true; this.#db.close();
  }
}
