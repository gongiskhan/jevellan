import { AuthStateSchema, ConsumeSwitchSchema, DeviceOriginSchema, DeviceRosterSchema, DeviceSwitchInputSchema, DeviceSwitchSchema, DeviceTokenSchema, DeviceViewSchema, EmptySchema, ErrorDocumentSchema, HeartbeatSchema, IdSchema, JoinedDeviceSchema, JoinDeviceInputSchema, JoinInvitationSchema, MeshSessionInputSchema, MeshSessionResultSchema, MeshSessionStateSchema, PassphraseInputSchema, SwitchedSessionSchema, UiSigningMaterialSchema, stableJson, type DocumentSchema, type SecretRedactor, type UiSigningMaterial } from '@jevellan/core';
import { verifySharedSession } from './auth.js';
import { AccountHubRequestSchema, AccountHubResultSchema } from '@jevellan/core';
import { CheckoutStoreRequestSchema, CheckoutStoreResultSchema, PublicationLeaseRequestSchema, PublicationLeaseResultSchema } from '@jevellan/core';
import { IndexRequestSchema, IndexResultSchema } from '@jevellan/core';
import { SharedStateRequestSchema, SharedStateResultSchema } from '@jevellan/core';
import { PeerSessionInputSchema, PeerSessionStateSchema } from '@jevellan/core';
import { PeerLoginSessionInputSchema, PeerLoginSessionStateSchema } from '@jevellan/core';
import { ImproverDeviceRequestSchema, ImproverDeviceResultSchema, ImproverRequestSchema, ImproverResultSchema } from '@jevellan/core';
import { ProjectHubCollectionSchema, ProjectHubRequestSchema, ProjectHubResultSchema, collectionOf, type ProjectHubCollection, type ProjectHubResult } from '@jevellan/core';
import { ProjectEnvelopeSchema, type ProjectEnvelope, type UnreadableEnvelope } from '@jevellan/core';
import { z } from 'zod';
import { AgentAccessHubRequestSchema, AgentAccessHubResultSchema } from '@jevellan/core';

import { HubUnavailable } from '@jevellan/core';
export { HubUnavailable } from '@jevellan/core';
export class HubProtocolError extends Error {
  readonly status = 502;
  constructor() { super('The hub returned an invalid response.'); }
}
type TransportOptions = { hubUrl: string; hubName: string; redactor: SecretRedactor; fetch?: typeof fetch; timeoutMs?: number };
class HubTransport {
  readonly origin: string;
  constructor(private readonly options: TransportOptions) { this.origin = DeviceOriginSchema.parse(options.hubUrl); }
  async request<T>(path: string, schema: DocumentSchema<T>, body: unknown | undefined, token?: string): Promise<T> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.origin}/hub/mesh/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${DeviceTokenSchema.parse(token)}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
        await response.body?.cancel(); throw new HubProtocolError();
      }
      const reader = response.body?.getReader(); if (!reader) throw new HubProtocolError();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new HubProtocolError(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new HubProtocolError(); }
      if (!response.ok) {
        const error = ErrorDocumentSchema.safeParse(value); if (!error.success) throw new HubProtocolError();
        throw Object.assign(new Error(this.options.redactor.text(error.data.message)), { status: response.status });
      }
      try { return schema.parse(value); } catch { throw new HubProtocolError(); }
    } catch (error) {
      if (error instanceof HubProtocolError || error && typeof error === 'object' && 'status' in error) throw error;
      throw new HubUnavailable(this.options.hubName);
    } finally { clearTimeout(timer); }
  }
}

export async function joinHub(options: TransportOptions, input: unknown) {
  const request = JoinDeviceInputSchema.parse(input); options.redactor.add(request.code);
  const transport = new HubTransport(options); const result = await transport.request('join', JoinedDeviceSchema, request);
  const member = result.membership.device; const hub = result.membership.hub;
  if (member.id !== request.device.id || member.role !== 'member' || hub.role !== 'hub' || hub.id === member.id || DeviceOriginSchema.parse(hub.url) !== transport.origin || member.url !== request.device.url || member.name !== request.device.name || member.os !== request.device.os) throw new HubProtocolError();
  options.redactor.add(result.membership.token); options.redactor.add(result.authentication.key);
  return result;
}

export type MemberHubOptions = TransportOptions & { deviceId: string; token(): string };
/** An `envelopes-pending` page whose records are read one by one. */
const PendingEnvelopePageSchema = z.strictObject({ schema: z.literal('project-hub-result-v1'), operation: z.literal('envelopes-pending'), records: z.array(z.unknown()).max(1000), more: z.boolean() });
const KindSchema = z.string().regex(/^[a-z-]{1,40}$/);
/** What an unreadable envelope record still names: each field when it reads as one, else null. */
function unreadableEnvelope(raw: unknown): UnreadableEnvelope {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const body = record.body && typeof record.body === 'object' ? record.body as Record<string, unknown> : {};
  const id = (value: unknown) => { const parsed = IdSchema.safeParse(value); return parsed.success ? parsed.data : null; };
  const kind = KindSchema.safeParse(body.kind);
  return { id: id(record.id), projectId: id(record.projectId), sourceDeviceId: id(record.sourceDeviceId), kind: kind.success ? kind.data : null };
}
export class MemberHubClient {
  readonly #transport: HubTransport;
  readonly deviceId: string;
  constructor(private readonly options: MemberHubOptions) { this.deviceId = IdSchema.parse(options.deviceId); this.#transport = new HubTransport(options); }
  #request<T>(path: string, schema: DocumentSchema<T>, body?: unknown) {
    const token = DeviceTokenSchema.parse(this.options.token()); this.options.redactor.add(token);
    return this.#transport.request(path, schema, body, token);
  }
  async devices() {
    const result = await this.#request('devices', DeviceRosterSchema);
    if (result.currentDeviceId !== this.deviceId) throw new HubProtocolError();
    return result;
  }
  async heartbeat(input: unknown) {
    const heartbeat = HeartbeatSchema.parse(input);
    if (heartbeat.deviceId !== this.deviceId) throw new Error('Heartbeat belongs to another device.');
    const result = await this.#request('heartbeat', DeviceViewSchema, heartbeat);
    if (result.device.id !== this.deviceId) throw new HubProtocolError();
    return result;
  }
  async invite() { const result = await this.#request('invitations', JoinInvitationSchema, EmptySchema.parse({ schema: 'empty-request-v1' })); this.options.redactor.add(result.code); return result; }
  async signingMaterial() { const result = await this.#request('auth/material', UiSigningMaterialSchema); this.options.redactor.add(result.key); return result; }
  async accountData(input: unknown) {
    const request = AccountHubRequestSchema.parse(input);
    if (request.operation === 'capture') this.options.redactor.add(request.secret);
    if (request.operation === 'add' && request.input.secret) this.options.redactor.add(request.input.secret);
    const result = await this.#request('accounts', AccountHubResultSchema, request);
    if (result.schema === 'account-credential-v1') this.options.redactor.add(result.value);
    return result;
  }
  checkout(input: unknown) { return this.#request('checkout', CheckoutStoreResultSchema, CheckoutStoreRequestSchema.parse(input)); }
  async agentAccess(input: unknown) {
    const request = AgentAccessHubRequestSchema.parse(input);
    if ('authorization' in request) this.options.redactor.add(request.authorization.replace(/^Bearer /, ''));
    if ('ownerSession' in request) this.options.redactor.add(request.ownerSession);
    const result = await this.#request('agent-access', AgentAccessHubResultSchema, request);
    if (result.schema === 'agent-access-created-v1' && result.token) this.options.redactor.add(result.token);
    return result;
  }
  publication(input: unknown) { return this.#request('publication', PublicationLeaseResultSchema, PublicationLeaseRequestSchema.parse(input)); }
  indexes(input: unknown) { return this.#request('indexes', IndexResultSchema, IndexRequestSchema.parse(input)); }
  async improver(input: unknown) {
    const request = ImproverRequestSchema.parse(input); const result = await this.#request('improver', ImproverResultSchema, request);
    const revision = (value: typeof result) => value.schema === 'routing-revision-record-v1' || value.schema === 'project-revision-record-v1' ? value : null;
    const valid = request.operation === 'state' ? result.schema === 'improver-state-v2'
      : request.operation === 'summary' ? result.schema === 'improver-summary-v1'
      : request.operation === 'run' ? result.schema === 'improver-job-view-v1' && result.scope.kind === 'routing' && result.scope.cycle.kind === 'manual'
      : request.operation === 'run-now' ? result.schema === 'improver-run-v1'
      : request.operation === 'log' ? (result.schema === 'routing-improver-log-v1' || result.schema === 'project-improver-log-v1') && result.jobId === request.jobId
      : request.operation === 'act' ? (result.schema === 'routing-suggestion-row-v1' || result.schema === 'project-suggestion-row-v1') && result.suggestion.id === request.suggestionId
      : request.operation === 'report' ? result.schema === 'memory-care-report-row-v1' && result.report.id === request.reportId
      : request.operation === 'notice-seen' ? result.schema === 'improver-summary-v1'
      : request.operation === 'revision' ? revision(result)?.id === request.id
      : revision(result)?.deviceId === this.deviceId && stableJson(revision(result)!.request) === stableJson(request.input);
    if (!valid) throw new HubProtocolError(); return result;
  }
  /** Device work for project jobs and checkout tasks; separate from browser improver requests. */
  improverDevice(input: unknown) { return this.#request('improver-device', ImproverDeviceResultSchema, ImproverDeviceRequestSchema.parse(input)); }
  async state(input: unknown) {
    const request = SharedStateRequestSchema.parse(input);
    if (request.operation === 'jev-put' || request.operation === 'github-put') this.options.redactor.add(request.value);
    const result = await this.#request('state', SharedStateResultSchema, request);
    if ((result.schema === 'shared-jev-credential-v1' || result.schema === 'shared-github-credential-v1') && result.value) this.options.redactor.add(result.value);
    return result;
  }
  /** Project hub state: one route per collection; the reply must answer the requested operation. */
  async projects(collection: ProjectHubCollection, input: unknown): Promise<ProjectHubResult> {
    const request = ProjectHubRequestSchema.parse(input);
    if (collectionOf(request.operation) !== ProjectHubCollectionSchema.parse(collection)) throw new Error('This operation belongs to another project collection.');
    const result = await this.#request(`projects/${collection}`, ProjectHubResultSchema, request);
    if (result.operation !== request.operation) throw new HubProtocolError();
    return result;
  }
  /**
   * `envelopes-pending` read record by record (P8 review S-2): the page itself must be well formed, but a record this version cannot read
   * comes back as unreadable, with what it still names, instead of failing the page and every envelope behind it.
   */
  async pendingEnvelopes(targetDeviceId: string): Promise<{ records: ProjectEnvelope[]; more: boolean; unreadable: UnreadableEnvelope[] }> {
    const request = ProjectHubRequestSchema.parse({ schema: 'project-hub-request-v1', operation: 'envelopes-pending', targetDeviceId });
    const page = await this.#request(`projects/${collectionOf(request.operation)}`, PendingEnvelopePageSchema, request);
    const records: ProjectEnvelope[] = []; const unreadable: UnreadableEnvelope[] = [];
    for (const raw of page.records) {
      const parsed = ProjectEnvelopeSchema.safeParse(raw);
      if (parsed.success) records.push(parsed.data); else unreadable.push(unreadableEnvelope(raw));
    }
    return { records, more: page.more, unreadable };
  }
  async session(token: string | null) {
    const result = await this.#request('auth/check', MeshSessionStateSchema, MeshSessionInputSchema.parse({ schema: 'mesh-session-input-v1', token }));
    if (result.session && result.session.deviceId !== this.deviceId) throw new HubProtocolError();
    return result;
  }
  async peerSession(raw: unknown) {
    const input = PeerSessionInputSchema.parse(raw); this.options.redactor.add(input.token);
    const result = await this.#request('auth/peer-check', PeerSessionStateSchema, input);
    if (result.targetDeviceId !== this.deviceId || result.sourceDeviceId !== input.sourceDeviceId || result.conversationId !== input.conversationId || result.session && result.session.deviceId !== input.sourceDeviceId) throw new HubProtocolError();
    return result;
  }
  async peerLoginSession(raw: unknown) {
    const input = PeerLoginSessionInputSchema.parse(raw); this.options.redactor.add(input.token);
    const result = await this.#request('auth/peer-login-check', PeerLoginSessionStateSchema, input);
    if (result.targetDeviceId !== this.deviceId || result.sourceDeviceId !== input.sourceDeviceId || result.session && result.session.deviceId !== input.sourceDeviceId) throw new HubProtocolError();
    return result;
  }
  async login(input: unknown) {
    const request = PassphraseInputSchema.parse(input); this.options.redactor.add(request.passphrase);
    const result = await this.#request('auth/login', MeshSessionResultSchema, request); this.options.redactor.add(result.token); return result.token;
  }
  async logout(token: string | null) {
    const result = await this.#request('auth/logout', MeshSessionStateSchema, MeshSessionInputSchema.parse({ schema: 'mesh-session-input-v1', token }));
    if (result.session) throw new HubProtocolError();
    return result;
  }
  async issueSwitch(input: unknown) {
    const request = DeviceSwitchInputSchema.parse(input); const result = await this.#request('switch', DeviceSwitchSchema, request);
    if (result.targetDeviceId !== request.targetDeviceId) throw new HubProtocolError();
    this.options.redactor.add(result.token); return result;
  }
  async consumeSwitch(input: unknown) {
    const request = ConsumeSwitchSchema.parse(input); this.options.redactor.add(request.token);
    const result = await this.#request('switch/consume', SwitchedSessionSchema, request);
    if (result.receipt.targetDeviceId !== this.deviceId) throw new HubProtocolError();
    this.options.redactor.add(result.token); return result;
  }
}

/** A member checks signatures locally and revocations with the hub on each authenticated request. */
export class MemberUiAuth {
  readonly deviceId: string;
  constructor(readonly hub: MemberHubClient, private readonly material: () => UiSigningMaterial) { this.deviceId = hub.deviceId; }
  configured(): boolean { return true; }
  setup(): never { throw Object.assign(new Error('The passphrase is managed by the hub. Sign in instead.'), { status: 409 }); }
  async login(input: unknown): Promise<string> {
    const token = await this.hub.login(input);
    if (!verifySharedSession(this.material(), token, this.deviceId)) throw new HubProtocolError();
    return token;
  }
  async verify(token: string | undefined) {
    const local = verifySharedSession(this.material(), token, this.deviceId); if (!local) return null;
    const result = await this.hub.session(token!);
    if (!result.configured || !result.session) return null;
    if (stableJson(result.session) !== stableJson(local)) throw new HubProtocolError();
    return result.session;
  }
  /** An already authorized stream can finish during a hub outage; new requests still require verify. */
  async verifyStream(token: string | undefined): Promise<boolean> {
    try { return Boolean(await this.verify(token)); }
    catch (error) {
      if (!(error instanceof HubUnavailable)) return false;
      return Boolean(verifySharedSession(this.material(), token, this.deviceId));
    }
  }
  async verifyPeer(raw: unknown, existingStream = false): Promise<boolean> {
    const input = PeerSessionInputSchema.parse(raw);
    const local = verifySharedSession(this.material(), input.token, input.sourceDeviceId); if (!local) return false;
    try {
      const result = await this.hub.peerSession(input);
      if (!result.session) return false;
      if (stableJson(result.session) !== stableJson(local)) throw new HubProtocolError();
      return true;
    } catch (error) {
      if (existingStream && error instanceof HubUnavailable) return Boolean(verifySharedSession(this.material(), input.token, input.sourceDeviceId));
      if (existingStream) return false;
      throw error;
    }
  }
  /** `existingStream`: like `verifyPeer`, an already admitted stream (a proxied Projects chat) can finish during a hub outage. */
  async verifyPeerLogin(raw: unknown, existingStream = false): Promise<boolean> {
    const input = PeerLoginSessionInputSchema.parse(raw);
    const local = verifySharedSession(this.material(), input.token, input.sourceDeviceId); if (!local) return false;
    try {
      const result = await this.hub.peerLoginSession(input);
      if (!result.session) return false;
      if (stableJson(result.session) !== stableJson(local)) throw new HubProtocolError();
      return true;
    } catch (error) {
      if (existingStream && error instanceof HubUnavailable) return true;
      if (existingStream) return false;
      throw error;
    }
  }
  async logout(token: string | undefined): Promise<void> { await this.hub.logout(token ?? null); }
  async state(token: string | undefined) { return AuthStateSchema.parse({ schema: 'auth-state-v1', configured: true, authenticated: Boolean(await this.verify(token)), deviceId: this.deviceId }); }
  async consumeSwitch(input: unknown) {
    const result = await this.hub.consumeSwitch(input);
    if (!verifySharedSession(this.material(), result.token, this.deviceId)) throw new HubProtocolError();
    return result;
  }
}
