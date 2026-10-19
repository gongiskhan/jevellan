import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { EkoaOAuthMetadataSchema, EkoaOAuthStartSchema, EkoaOAuthCallbackSchema, EkoaOAuthVaultSchema, EkoaOAuthStatusSchema, EkoaUrlSchema } from '@jevellan/core';
import type { HubDatabase } from '@jevellan/mesh';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const scopes = ['ekoa.read', 'ekoa.write'];
const resourceMetadata = z.object({ resource: EkoaUrlSchema, authorization_servers: z.array(EkoaUrlSchema).min(1).max(10), scopes_supported: z.array(z.string()).max(50).optional() });
const serverMetadata = z.object({ issuer: EkoaUrlSchema, authorization_endpoint: EkoaUrlSchema, token_endpoint: EkoaUrlSchema, registration_endpoint: EkoaUrlSchema.optional(),
  response_types_supported: z.array(z.string()).max(30), code_challenge_methods_supported: z.array(z.string()).max(30), token_endpoint_auth_methods_supported: z.array(z.string()).max(30), scopes_supported: z.array(z.string()).max(50) });
const registration = z.object({ client_id: z.string().min(1).max(2000), token_endpoint_auth_method: z.literal('none'), redirect_uris: z.array(EkoaUrlSchema).max(10) });
const tokens = z.object({ access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(8192), token_type: z.literal('Bearer'), expires_in: z.number().int().positive().max(31536000), scope: z.string().max(1000) });
type Record = z.infer<typeof EkoaOAuthVaultSchema>;

/** The state point alone holds registration, PKCE and rotating tokens in one encrypted vault record. */
export class EkoaOAuthService {
  #queue: Promise<unknown> = Promise.resolve();
  #epoch = 0;
  constructor(readonly hub: HubDatabase, readonly hubUrl: () => string, readonly fetcher: typeof fetch = fetch, readonly now = Date.now) { this.status(); }
  #load(): Record | null {
    if (!this.hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('ekoa-oauth')) return null;
    const value = EkoaOAuthVaultSchema.parse(JSON.parse(this.hub.vault.forLaunch('ekoa-oauth')));
    if (value.pending) this.hub.redactor.add(value.pending.verifier);
    if (value.tokens) { this.hub.redactor.add(value.tokens.accessToken); this.hub.redactor.add(value.tokens.refreshToken); }
    return value;
  }
  #save(value: Record, epoch: number) {
    if (epoch !== this.#epoch) throw new Error('Ekoa connection settings changed. Connect again.');
    const record = EkoaOAuthVaultSchema.parse(value);
    if (record.pending) this.hub.redactor.add(record.pending.verifier);
    if (record.tokens) { this.hub.redactor.add(record.tokens.accessToken); this.hub.redactor.add(record.tokens.refreshToken); }
    this.hub.vault.put('ekoa-oauth', JSON.stringify(record));
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work); this.#queue = result.then(() => undefined, () => undefined); return result;
  }
  disconnect() { this.#epoch++; this.hub.vault.remove('ekoa-oauth'); }
  status() {
    try {
      const record = this.#load();
      return EkoaOAuthStatusSchema.parse({ schema: 'ekoa-oauth-status-v1', connected: !!record?.tokens, connecting: !!record?.pending && Date.parse(record.pending.expiresAt) > this.now() });
    } catch { return EkoaOAuthStatusSchema.parse({ schema: 'ekoa-oauth-status-v1', connected: false, connecting: false, reason: 'Saved Ekoa OAuth data is unavailable. Connect again.' }); }
  }
  hasTokens(url: string) { const record = this.#load(); return record?.url === url && !!record.tokens; }
  async #json(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Ekoa OAuth request failed (status ${response.status}).`); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 64 * 1024) { await reader.cancel(); throw new Error('Ekoa OAuth response exceeds its limit.'); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Ekoa OAuth returned invalid JSON.'); }
  }
  async discover(url: string) {
    const target = new URL(EkoaUrlSchema.parse(url));
    const resource = resourceMetadata.parse(await this.#json(`${target.origin}/.well-known/oauth-protected-resource`));
    if (new URL(resource.resource).origin !== target.origin) throw new Error('Ekoa OAuth names another resource.');
    const issuer = resource.authorization_servers[0]!.replace(/\/$/u, '');
    const authorization = serverMetadata.parse(await this.#json(`${new URL(issuer).origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname === '/' ? '' : new URL(issuer).pathname}`));
    if (authorization.issuer.replace(/\/$/u, '') !== issuer || !authorization.code_challenge_methods_supported.includes('S256') || !authorization.response_types_supported.includes('code') || !authorization.token_endpoint_auth_methods_supported.includes('none') || scopes.some(scope => !authorization.scopes_supported.includes(scope))) throw new Error('Ekoa OAuth must support code, PKCE S256, public clients and task read/write scopes.');
    return EkoaOAuthMetadataSchema.parse({ schema: 'ekoa-oauth-metadata-v1', issuer: authorization.issuer, resource: resource.resource, authorizationEndpoint: authorization.authorization_endpoint, tokenEndpoint: authorization.token_endpoint, registrationEndpoint: authorization.registration_endpoint ?? null, scopes });
  }
  #authorization(record: Record) {
    const pending = record.pending!;
    const url = new URL(record.metadata.authorizationEndpoint);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: record.clientId, redirect_uri: record.redirectUri, scope: scopes.join(' '), state: pending.state,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'), code_challenge_method: 'S256', resource: record.metadata.resource })) url.searchParams.set(name, value);
    return EkoaOAuthStatusSchema.parse({ ...this.status(), authorizationUrl: url.href });
  }
  start(raw: z.input<typeof EkoaOAuthStartSchema>, ownerSession: string) { return this.#serial(async () => {
    const input = EkoaOAuthStartSchema.parse(raw), epoch = this.#epoch, redirectUri = EkoaUrlSchema.parse(new URL('/settings/ekoa/callback', this.hubUrl()).href), owner = this.hub.vault.requestFingerprint(ownerSession);
    let record: Record | null;
    try { record = this.#load(); }
    catch { this.hub.vault.remove('ekoa-oauth'); record = null; }
    if (record?.pending?.id === input.clientRequestId && Date.parse(record.pending.expiresAt) > this.now()) {
      if (record.url !== input.url || record.redirectUri !== redirectUri || record.pending.owner !== owner) throw new Error('This connection request id has different details.');
      return this.#authorization(record);
    }
    const metadata = await this.discover(input.url);
    if (!metadata.registrationEndpoint) throw new Error(`Ekoa does not offer dynamic registration. Create a public OAuth client named Jevellan, authorization code and refresh grants, PKCE S256, scopes ${scopes.join(' ')}, redirect ${redirectUri}. Client configuration is blocked until it exists.`);
    if (!record || record.url !== input.url || record.redirectUri !== redirectUri || JSON.stringify(record.metadata) !== JSON.stringify(metadata)) {
      const client = registration.parse(await this.#json(metadata.registrationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Jevellan', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ') }) }));
      if (!client.redirect_uris.includes(redirectUri)) throw new Error('Ekoa registered another redirect URI.');
      record = { schema: 'ekoa-oauth-vault-v1', url: input.url, redirectUri, metadata, clientId: client.client_id, pending: null, tokens: null };
    }
    record = { ...record, pending: { id: input.clientRequestId, state: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url'), owner, expiresAt: new Date(this.now() + 15 * 60000).toISOString() } };
    this.#save(record, epoch); return this.#authorization(record);
  }); }
  async #exchange(record: Record, form: URLSearchParams, epoch: number): Promise<Record> {
    form.set('client_id', record.clientId); form.set('resource', record.metadata.resource);
    const result = tokens.parse(await this.#json(record.metadata.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
    if (scopes.some(scope => !result.scope.split(/\s/u).includes(scope))) throw new Error('Ekoa did not grant task read/write scopes.');
    const saved = { ...record, tokens: { accessToken: result.access_token, refreshToken: result.refresh_token, scope: result.scope, expiresAt: new Date(this.now() + result.expires_in * 1000).toISOString() } };
    this.#save(saved, epoch); return saved;
  }
  complete(raw: z.input<typeof EkoaOAuthCallbackSchema>, ownerSession: string) { return this.#serial(async () => {
    const input = EkoaOAuthCallbackSchema.parse(raw), record = this.#load(), epoch = this.#epoch, owner = this.hub.vault.requestFingerprint(ownerSession);
    if (!record?.pending && record?.tokens && record.completed?.state === digest(input.state) && record.completed.owner === owner) return this.status();
    if (!record?.pending || record.pending.state !== input.state || record.pending.owner !== owner || Date.parse(record.pending.expiresAt) <= this.now()) throw new Error('The Ekoa sign-in expired or belongs to another browser. Connect again.');
    if (input.error || !input.code) { this.#save({ ...record, pending: null }, epoch); throw new Error('Ekoa sign-in was not completed. Connect again when ready.'); }
    this.hub.redactor.add(input.code);
    await this.#exchange({ ...record, pending: null, completed: { state: digest(input.state), owner } }, new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: record.redirectUri, code_verifier: record.pending.verifier }), epoch);
    return this.status();
  }); }
  accessToken(url: string) { return this.#serial(async () => {
    const record = this.#load(), epoch = this.#epoch;
    if (record?.url !== url || !record.tokens) throw new Error('Connect to Ekoa in Settings.');
    if (Date.parse(record.tokens.expiresAt) > this.now() + 60_000) return record.tokens.accessToken;
    const refreshed = await this.#exchange(record, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.tokens.refreshToken }), epoch);
    return refreshed.tokens!.accessToken;
  }); }
}
