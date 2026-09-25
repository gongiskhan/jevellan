import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DaemonOwnershipSchema } from './schemas.js';
import type { Homes } from './homes.js';
import { processStartIdentity } from './process-group.js';

export function daemonRunning(homes: Homes): boolean {
  const file = homes.at('locks', 'daemon.db');
  if (file !== join(homes.root, 'locks', 'daemon.db')) throw new Error('Daemon ownership cannot alias another file.');
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT document FROM owner WHERE id=1').get();
    const owner = row ? DaemonOwnershipSchema.parse(JSON.parse(String(row.document))) : null;
    return !!owner?.held && processStartIdentity(owner.pid) === owner.startIdentity;
  } finally { db.close(); }
}

/** Local ownership only; this database is never the hub or a member's cache. */
export class DaemonOwnership {
  readonly #db: DatabaseSync;
  readonly #token = `daemon_${randomUUID()}`;
  #closed = false;
  constructor(homes: Homes) {
    homes.ensure('locks');
    const file = homes.at('locks', 'daemon.db');
    if (file !== join(homes.root, 'locks', 'daemon.db')) throw new Error('Daemon ownership cannot alias another file.');
    try { writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    chmodSync(file, 0o600); this.#db = new DatabaseSync(file);
    try {
      this.#db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL); BEGIN IMMEDIATE;');
      const row = this.#db.prepare('SELECT document FROM owner WHERE id=1').get();
      const previous = row ? DaemonOwnershipSchema.parse(JSON.parse(String(row.document))) : null;
      if (previous?.held && processStartIdentity(previous.pid) === previous.startIdentity) throw new Error('Another Jevellan daemon already owns this data home.');
      const startIdentity = processStartIdentity(process.pid);
      if (!startIdentity) throw new Error('Cannot establish daemon process identity.');
      const document = DaemonOwnershipSchema.parse({ schema: 'daemon-ownership-v1', pid: process.pid, startIdentity, token: this.#token, held: true });
      this.#db.prepare('INSERT INTO owner(id,document) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(JSON.stringify(document));
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Opening may have failed before the transaction. */ }
      this.#db.close(); throw error;
    }
  }
  assert(): void {
    if (this.#closed) throw new Error('Daemon data-home ownership is closed.');
    const row = this.#db.prepare('SELECT document FROM owner WHERE id=1').get();
    const current = row ? DaemonOwnershipSchema.parse(JSON.parse(String(row.document))) : null;
    if (!current?.held || current.token !== this.#token) throw new Error('Daemon data-home ownership was lost.');
  }
  close(): void {
    if (this.#closed) return;
    try {
      this.#db.exec('BEGIN IMMEDIATE'); this.assert();
      const row = this.#db.prepare('SELECT document FROM owner WHERE id=1').get()!;
      const current = DaemonOwnershipSchema.parse(JSON.parse(String(row.document)));
      this.#db.prepare('UPDATE owner SET document=? WHERE id=1').run(JSON.stringify({ ...current, held: false }));
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    finally { this.#closed = true; this.#db.close(); }
  }
}
