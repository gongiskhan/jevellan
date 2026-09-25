import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, TimestampSchema, PassphraseInputSchema, AuthStateSchema, UiSessionSchema, UiSigningMaterialSchema, newId, type DocumentStore, type SecretVault, type UiSigningMaterial } from '@jevellan/core';

const PassphraseSchema = z.strictObject({
  schema: z.literal('passphrase-v1'), salt: z.base64(), hash: z.base64(), keyRef: IdSchema,
  generation: z.number().int().positive(), at: TimestampSchema,
});
const RevokedSessionSchema = z.strictObject({ schema: z.literal('revoked-session-v1'), id: IdSchema, expiresAt: TimestampSchema });
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
  async login(input: unknown, address: string, deviceId = this.deviceId): Promise<string> {
    this.#limit(address); const value = PassphraseInputSchema.parse(input); const current = this.#configuration();
    if (!current) throw Object.assign(new Error('Set the passphrase first.'), { status: 409 });
    const candidate = await derive(value.passphrase, Buffer.from(current.document.salt, 'base64'));
    const expected = Buffer.from(current.document.hash, 'base64');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw Object.assign(new Error('The passphrase is incorrect.'), { status: 401 });
    this.#attempts.delete(address); return this.issue(deviceId);
  }
  signingMaterial(): UiSigningMaterial {
    const configuration = this.#configuration()?.document;
    if (!configuration) throw new Error('Set the passphrase first.');
    return UiSigningMaterialSchema.parse({ schema: 'ui-signing-material-v1', key: this.vault.forLaunch(configuration.keyRef), generation: configuration.generation });
  }
  issue(deviceId = this.deviceId): string {
    const material = this.signingMaterial();
    const session = UiSessionSchema.parse({ schema: 'ui-session-v1', id: newId('session'), deviceId: IdSchema.parse(deviceId), generation: material.generation, expiresAt: new Date(Date.now() + SESSION_MS).toISOString() });
    const body = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(material.key, 'base64')).update(body).digest('base64url');
    return `${body}.${signature}`;
  }
  verify(token: string | undefined, deviceId = this.deviceId): z.infer<typeof UiSessionSchema> | null {
    try {
      if (!token || !this.configured()) return null;
      const session = verifySharedSession(this.signingMaterial(), token, deviceId); if (!session) return null;
      if (this.store.get('revoked-sessions', session.id, RevokedSessionSchema)) return null;
      return session;
    } catch { return null; }
  }
  logout(token: string | undefined, deviceId = this.deviceId): void {
    const session = this.verify(token, deviceId); if (!session) return;
    this.store.put('revoked-sessions', session.id, RevokedSessionSchema, { schema: 'revoked-session-v1', id: session.id, expiresAt: session.expiresAt }, 0);
  }
  state(token: string | undefined) { return AuthStateSchema.parse({ schema: 'auth-state-v1', configured: this.configured(), authenticated: Boolean(this.verify(token)), deviceId: this.deviceId }); }
}

/** Signature/device/expiry check only. Revocation is always checked with the hub. */
export function verifySharedSession(material: UiSigningMaterial, token: string | undefined, deviceId: string, now = Date.now()) {
  if (!token || token.length > 4096) return null;
  try {
    const signing = UiSigningMaterialSchema.parse(material);
    const parts = token.split('.'); if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const [body, signature] = parts as [string, string];
    const expected = createHmac('sha256', Buffer.from(signing.key, 'base64')).update(body).digest(); const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;
    const session = UiSessionSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return session.deviceId === deviceId && session.generation === signing.generation && Date.parse(session.expiresAt) > now ? session : null;
  } catch { return null; }
}

export function sessionFromCookie(header: string | undefined): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}
export function sessionCookie(token: string, secure = false): string { return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`; }
export function clearSessionCookie(secure = false): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`; }

export { PassphraseInputSchema, AuthStateSchema } from '@jevellan/core';
