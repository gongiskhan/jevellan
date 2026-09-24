import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, TimestampSchema, newId, type DocumentStore, type SecretVault } from '@jevellan/core';

export const PassphraseInputSchema = z.strictObject({ schema: z.literal('passphrase-input-v1'), passphrase: z.string().min(8).max(1024) });
const PassphraseSchema = z.strictObject({
  schema: z.literal('passphrase-v1'), salt: z.base64(), hash: z.base64(), keyRef: IdSchema,
  generation: z.number().int().positive(), at: TimestampSchema,
});
const SessionSchema = z.strictObject({ schema: z.literal('ui-session-v1'), id: IdSchema, deviceId: IdSchema, generation: z.number().int().positive(), expiresAt: TimestampSchema });
const RevokedSessionSchema = z.strictObject({ schema: z.literal('revoked-session-v1'), id: IdSchema, expiresAt: TimestampSchema });
export const AuthStateSchema = z.strictObject({ schema: z.literal('auth-state-v1'), configured: z.boolean(), authenticated: z.boolean(), deviceId: IdSchema });
export const SESSION_COOKIE = 'jevellan_session';
const SESSION_MS = 7 * 24 * 60 * 60_000;
const derive = (passphrase: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result));
});

export class UiAuth {
  #attempts = new Map<string, { count: number; resetsAt: number }>();
  constructor(private readonly store: DocumentStore, private readonly vault: SecretVault, readonly deviceId: string) { IdSchema.parse(deviceId); }
  #configuration() { return this.store.get('authentication', 'ui', PassphraseSchema); }
  configured(): boolean { return Boolean(this.#configuration()); }
  async setup(input: unknown): Promise<string> {
    const value = PassphraseInputSchema.parse(input);
    if (this.configured()) throw Object.assign(new Error('The passphrase is already set. Sign in instead.'), { status: 409 });
    const salt = randomBytes(16); const hash = await derive(value.passphrase, salt); const keyRef = newId('sessionkey');
    this.vault.put(keyRef, randomBytes(32).toString('base64'));
    try {
      this.store.put('authentication', 'ui', PassphraseSchema, { schema: 'passphrase-v1', salt: salt.toString('base64'), hash: hash.toString('base64'), keyRef, generation: 1, at: new Date().toISOString() }, 0);
    } catch (error) { this.vault.remove(keyRef); throw error; }
    return this.issue();
  }
  #limit(address: string): void {
    const now = Date.now();
    for (const [key, entry] of this.#attempts) if (entry.resetsAt <= now) this.#attempts.delete(key);
    if (this.#attempts.size >= 10_000 && !this.#attempts.has(address)) throw Object.assign(new Error('Too many sign-in attempts. Try again in a minute.'), { status: 429 });
    const entry = this.#attempts.get(address) ?? { count: 0, resetsAt: now + 60_000 };
    entry.count++; this.#attempts.set(address, entry);
    if (entry.count > 5) throw Object.assign(new Error('Too many sign-in attempts. Try again in a minute.'), { status: 429 });
  }
  async login(input: unknown, address: string): Promise<string> {
    this.#limit(address); const value = PassphraseInputSchema.parse(input); const current = this.#configuration();
    if (!current) throw Object.assign(new Error('Set the passphrase first.'), { status: 409 });
    const candidate = await derive(value.passphrase, Buffer.from(current.document.salt, 'base64'));
    const expected = Buffer.from(current.document.hash, 'base64');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw Object.assign(new Error('The passphrase is incorrect.'), { status: 401 });
    this.#attempts.delete(address); return this.issue();
  }
  issue(): string {
    const configuration = this.#configuration()?.document;
    if (!configuration) throw new Error('Set the passphrase first.');
    const session = SessionSchema.parse({ schema: 'ui-session-v1', id: newId('session'), deviceId: this.deviceId, generation: configuration.generation, expiresAt: new Date(Date.now() + SESSION_MS).toISOString() });
    const body = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(this.vault.forLaunch(configuration.keyRef), 'base64')).update(body).digest('base64url');
    return `${body}.${signature}`;
  }
  verify(token: string | undefined): z.infer<typeof SessionSchema> | null {
    if (!token || token.length > 4096) return null;
    try {
      const configuration = this.#configuration()?.document; if (!configuration) return null;
      const parts = token.split('.'); if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
      const [body, signature] = parts as [string, string];
      const expected = createHmac('sha256', Buffer.from(this.vault.forLaunch(configuration.keyRef), 'base64')).update(body).digest(); const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;
      const session = SessionSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      if (session.deviceId !== this.deviceId || session.generation !== configuration.generation || Date.parse(session.expiresAt) <= Date.now()) return null;
      if (this.store.get('revoked-sessions', session.id, RevokedSessionSchema)) return null;
      return session;
    } catch { return null; }
  }
  logout(token: string | undefined): void {
    const session = this.verify(token); if (!session) return;
    this.store.put('revoked-sessions', session.id, RevokedSessionSchema, { schema: 'revoked-session-v1', id: session.id, expiresAt: session.expiresAt }, 0);
  }
  state(token: string | undefined) { return AuthStateSchema.parse({ schema: 'auth-state-v1', configured: this.configured(), authenticated: Boolean(this.verify(token)), deviceId: this.deviceId }); }
}

export function sessionFromCookie(header: string | undefined): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}
export function sessionCookie(token: string, secure = false): string { return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`; }
export function clearSessionCookie(secure = false): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`; }
