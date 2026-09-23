import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Homes } from './homes.js';
import { IdSchema, TimestampSchema } from './schemas.js';
import type { SecretRedactor } from './environment.js';

const EnvelopeSchema = z.strictObject({
  schema: z.literal('secret-envelope-v1'), id: IdSchema, nonce: z.base64(), ciphertext: z.base64(), tag: z.base64(),
  lastFour: z.string().max(4), updatedAt: TimestampSchema,
});
export const SecretSummarySchema = z.strictObject({ schema: z.literal('secret-summary-v1'), id: IdSchema, saved: z.literal(true), lastFour: z.string().max(4) });
export type SecretSummary = z.infer<typeof SecretSummarySchema>;

export class SecretVault {
  readonly #key: Buffer;
  constructor(private readonly db: DatabaseSync, homes: Homes, private readonly redactor?: SecretRedactor) {
    homes.ensure('hub');
    const keyPath = homes.at('hub', 'secret.key');
    db.exec('CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, document TEXT NOT NULL)');
    try { lstatSync(keyPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Number(db.prepare('SELECT count(*) AS total FROM secrets').get()?.total) > 0) throw new Error('The vault key is missing. Restore it before accessing saved secrets.');
    }
    try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(keyPath).isFile()) throw new Error('Invalid vault key file.');
    chmodSync(keyPath, 0o600);
    this.#key = readFileSync(keyPath);
    if (this.#key.length !== 32) throw new Error('Invalid vault key length.');
  }
  put(id: string, value: string): SecretSummary {
    IdSchema.parse(id);
    if (!value || value.length > 64 * 1024) throw new Error('Secret must be nonempty and at most 64 KB.');
    this.redactor?.add(value);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(`secret-envelope-v1:${id}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const envelope = EnvelopeSchema.parse({ schema: 'secret-envelope-v1', id, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'), lastFour: value.length > 4 ? value.slice(-4) : '••••', updatedAt: new Date().toISOString() });
    this.db.prepare('INSERT INTO secrets(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(id, JSON.stringify(envelope));
    return { schema: 'secret-summary-v1', id, saved: true, lastFour: envelope.lastFour };
  }
  #read(id: string) {
    IdSchema.parse(id);
    const row = this.db.prepare('SELECT document FROM secrets WHERE id=?').get(id);
    if (!row) throw new Error('Saved secret is unavailable.');
    const envelope = EnvelopeSchema.parse(JSON.parse(String(row.document)));
    if (envelope.id !== id) throw new Error('Saved secret identity does not match.');
    return envelope;
  }
  summary(id: string): SecretSummary {
    const envelope = this.#read(id);
    return { schema: 'secret-summary-v1', id, saved: true, lastFour: envelope.lastFour };
  }
  forLaunch(id: string): string {
    const envelope = this.#read(id);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(Buffer.from(`secret-envelope-v1:${id}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const value = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      this.redactor?.add(value);
      return value;
    } catch { throw new Error('Saved secret could not be authenticated.'); }
  }
  remove(id: string): void { this.db.prepare('DELETE FROM secrets WHERE id=?').run(IdSchema.parse(id)); }
}
