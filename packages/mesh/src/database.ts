import { DatabaseSync } from 'node:sqlite';
import { chmodSync, writeFileSync } from 'node:fs';
import { ConfigurationStore, IdSchema, SecretRedactor, SecretVault, type DocumentSchema, type Homes } from '@jevellan/core';

export class HubDatabase {
  readonly db: DatabaseSync;
  readonly configuration: ConfigurationStore;
  readonly vault: SecretVault;
  readonly redactor: SecretRedactor;
  constructor(homes: Homes, role: 'hub' | 'member', redactor = new SecretRedactor()) {
    if (role !== 'hub') throw new Error('Member devices must use the hub HTTP API.');
    homes.ensure(); homes.ensure('hub');
    const file = homes.at('hub', 'jevellan.db');
    try { writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported hub database version.'); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS documents (namespace TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(namespace,id)); PRAGMA user_version=1;');
    this.redactor = redactor;
    try {
      this.configuration = new ConfigurationStore(this.db);
      this.vault = new SecretVault(this.db, homes, redactor);
    } catch (error) { this.db.close(); throw error; }
  }
  get<T>(namespace: string, id: string, schema: DocumentSchema<T>): { revision: number; document: T } | null {
    const row = this.db.prepare('SELECT revision,document FROM documents WHERE namespace=? AND id=?').get(IdSchema.parse(namespace), IdSchema.parse(id));
    return row ? { revision: Number(row.revision), document: schema.parse(JSON.parse(String(row.document))) } : null;
  }
  list<T>(namespace: string, schema: DocumentSchema<T>): Array<{ revision: number; document: T }> {
    return this.db.prepare('SELECT revision,document FROM documents WHERE namespace=? ORDER BY id').all(IdSchema.parse(namespace)).map((row) => ({ revision: Number(row.revision), document: schema.parse(JSON.parse(String(row.document))) }));
  }
  put<T>(namespace: string, id: string, schema: DocumentSchema<T>, document: unknown, expectedRevision: number): { revision: number; document: T } {
    const validated = schema.parse(document);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(namespace, id, schema);
      if ((current?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('This item changed. Reload it before saving.'), { status: 409 });
      const revision = expectedRevision + 1;
      this.db.prepare('INSERT INTO documents(namespace,id,revision,document) VALUES(?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET revision=excluded.revision,document=excluded.document').run(namespace, id, revision, JSON.stringify(validated));
      this.db.exec('COMMIT');
      return { revision, document: validated };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
