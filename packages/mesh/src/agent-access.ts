import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AgentAccessCreateSchema, AgentAccessCreatedSchema, AgentAccessGrantSchema, AgentAccessHubRequestSchema, AgentAccessHubResultSchema, AgentAccessRecordSchema, AgentConnectionSchema, IdSchema, newId, stableJson, type AgentAccessGrant, type AgentConnection } from '@jevellan/core';
import type { HubDatabase } from './database.js';
import type { MemberHubClient } from './client.js';
import type { UiAuth } from './auth.js';
import { AgentMailSendSchema, AgentMailSentSchema, AgentMailListSchema, ProjectSchema } from '@jevellan/core';

const namespace = 'agent-access';
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
export function assertAgentProject(grant: AgentAccessGrant, projectId: string): void {
  IdSchema.parse(projectId);
  if (grant.projectIds && !grant.projectIds.includes(projectId)) throw failure('This agent connection cannot access that project.', 403);
}
export class HubAgentAccess {
  constructor(private readonly hub: HubDatabase, private readonly now: () => number = Date.now) {}
  list(): AgentConnection[] { return this.hub.list(namespace, AgentAccessRecordSchema).map(row => row.document.connection).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  create(input: unknown) {
    const request = AgentAccessCreateSchema.parse(input);
    const fingerprint = this.hub.vault.requestFingerprint(stableJson(request));
    return this.hub.transaction(() => {
      const existing = this.hub.list(namespace, AgentAccessRecordSchema).find(row => row.document.clientRequestId === request.clientRequestId);
      if (existing) {
        if (existing.document.requestFingerprint !== fingerprint) throw failure('This connection request was already used with other choices.', 409);
        return AgentAccessCreatedSchema.parse({ schema: 'agent-access-created-v1', connection: existing.document.connection, created: false });
      }
      const now = this.now();
      const expiresAt = request.lifetimeDays === undefined ? request.expiresAt : new Date(now + request.lifetimeDays * 86_400_000).toISOString();
      if (expiresAt && Date.parse(expiresAt) <= now) throw failure('Choose an expiry in the future.', 400);
      for (const projectId of request.projectIds ?? []) if (!this.hub.db.prepare("SELECT 1 FROM documents WHERE namespace='projects' AND id=?").get(projectId)) throw failure('One of the selected projects does not exist.', 404);
      const id = newId('agent'); const token = `jva_${id}.${randomBytes(32).toString('base64url')}`; const tokenRef = newId('agent_token');
      const connection = AgentConnectionSchema.parse({ schema: 'agent-connection-v1', id, label: request.label, createdAt: new Date(now).toISOString(), tokenSuffix: token.slice(-4),
        ...(request.projectIds ? { projectIds: request.projectIds } : {}), ...(expiresAt ? { expiresAt } : {}) });
      this.hub.vault.put(tokenRef, token);
      this.hub.put(namespace, id, AgentAccessRecordSchema, { schema: 'agent-access-record-v1', connection, tokenRef, tokenFingerprint: this.hub.vault.requestFingerprint(token), clientRequestId: request.clientRequestId, requestFingerprint: fingerprint }, 0);
      return AgentAccessCreatedSchema.parse({ schema: 'agent-access-created-v1', connection, token, created: true });
    });
  }
  revoke(connectionId: string): AgentConnection {
    return this.hub.transaction(() => {
      const stored = this.hub.get(namespace, IdSchema.parse(connectionId), AgentAccessRecordSchema);
      if (!stored) throw failure('Agent connection not found.', 404);
      if (stored.document.connection.revokedAt) return stored.document.connection;
      const connection = AgentConnectionSchema.parse({ ...stored.document.connection, revokedAt: new Date(this.now()).toISOString() });
      this.hub.put(namespace, connectionId, AgentAccessRecordSchema, { ...stored.document, connection }, stored.revision);
      this.hub.vault.remove(stored.document.tokenRef);
      return connection;
    });
  }
  isActive(connectionId: string): boolean {
    const connection = this.hub.get(namespace, IdSchema.parse(connectionId), AgentAccessRecordSchema)?.document.connection;
    return !!connection && !connection.revokedAt && (!connection.expiresAt || Date.parse(connection.expiresAt) > this.now());
  }
  authenticateBearer(authorization: string | undefined): AgentAccessGrant | null {
    const match = authorization?.match(/^Bearer (jva_([A-Za-z0-9_-]{1,128})\.[A-Za-z0-9_-]{43})$/);
    if (!match || !this.isActive(match[2]!)) return null;
    const record = this.hub.get(namespace, match[2]!, AgentAccessRecordSchema)!.document;
    const received = this.hub.vault.requestFingerprint(match[1]!);
    if (!timingSafeEqual(Buffer.from(record.tokenFingerprint, 'hex'), Buffer.from(received, 'hex'))) return null;
    this.hub.redactor.add(match[1]!);
    const connection = record.connection;
    return AgentAccessGrantSchema.parse({ schema: 'agent-access-grant-v1', connectionId: connection.id, label: connection.label,
      ...(connection.projectIds ? { projectIds: connection.projectIds } : {}), ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}) });
  }
  #mailProject(projectId: string, authorization: string): AgentAccessGrant {
    const grant = this.authenticateBearer(authorization);
    if (!grant) throw failure('This agent connection was revoked, expired or is invalid.', 401);
    assertAgentProject(grant, projectId);
    if (!this.hub.get('projects', projectId, ProjectSchema)) throw failure('Project not found.', 404);
    return grant;
  }
  sendMail(raw: unknown, authorization: string): ReturnType<typeof AgentMailSentSchema.parse> {
    const input = AgentMailSendSchema.parse(raw); this.#mailProject(input.projectId, authorization);
    throw failure('Mail and reservations have been retired.', 410);
  }
  mailList(projectId: string, after: string | undefined, authorization: string): ReturnType<typeof AgentMailListSchema.parse> {
    this.#mailProject(projectId, authorization); if (after !== undefined) IdSchema.parse(after);
    throw failure('Mail and reservations have been retired.', 410);
  }
  request(input: unknown, deviceId: string, auth: UiAuth) {
    const request = AgentAccessHubRequestSchema.parse(input);
    if ('ownerSession' in request && !auth.verify(request.ownerSession, deviceId)) throw failure('Sign in to Jevellan before managing agent connections.', 401);
    const result = request.operation === 'list' ? { schema: 'agent-access-connections-v1', connections: this.list() }
      : request.operation === 'create' ? this.create(request.input)
      : request.operation === 'revoke' ? this.revoke(request.connectionId)
      : request.operation === 'active' ? { schema: 'agent-access-active-v1', active: this.isActive(request.connectionId) }
      : request.operation === 'mail-send' ? this.sendMail(request.input, request.authorization)
      : request.operation === 'mail-list' ? this.mailList(request.projectId, request.after, request.authorization)
      : { schema: 'agent-access-authentication-v1', grant: this.authenticateBearer(request.authorization) };
    return AgentAccessHubResultSchema.parse(result);
  }
}

/** UI operations always carry the member's owner session to the authoritative hub. */
export class AgentAccess {
  constructor(private readonly hub: HubAgentAccess | undefined, private readonly member: MemberHubClient | undefined) {}
  async list(ownerSession: string): Promise<AgentConnection[]> {
    if (this.hub) return this.hub.list();
    const result = await this.member!.agentAccess({ schema: 'agent-access-hub-request-v1', operation: 'list', ownerSession });
    if (result.schema !== 'agent-access-connections-v1') throw failure('The hub returned an invalid agent connection list.', 502);
    return result.connections;
  }
  async create(input: unknown, ownerSession: string) {
    if (this.hub) return this.hub.create(input);
    const result = await this.member!.agentAccess({ schema: 'agent-access-hub-request-v1', operation: 'create', input, ownerSession });
    if (result.schema !== 'agent-access-created-v1') throw failure('The hub returned an invalid agent connection.', 502);
    return result;
  }
  async revoke(connectionId: string, ownerSession: string) {
    if (this.hub) return this.hub.revoke(connectionId);
    const result = await this.member!.agentAccess({ schema: 'agent-access-hub-request-v1', operation: 'revoke', connectionId, ownerSession });
    if (result.schema !== 'agent-connection-v1' || result.id !== connectionId) throw failure('The hub returned an invalid agent connection.', 502);
    return result;
  }
  async authenticateBearer(authorization: string | undefined): Promise<AgentAccessGrant | null> {
    if (this.hub) return this.hub.authenticateBearer(authorization);
    if (!authorization || authorization.length > 512) return null;
    const result = await this.member!.agentAccess({ schema: 'agent-access-hub-request-v1', operation: 'authenticate', authorization });
    if (result.schema !== 'agent-access-authentication-v1') throw failure('The hub returned an invalid agent authentication.', 502);
    return result.grant;
  }
  async isActive(connectionId: string): Promise<boolean> {
    if (this.hub) return this.hub.isActive(connectionId);
    const result = await this.member!.agentAccess({ schema: 'agent-access-hub-request-v1', operation: 'active', connectionId });
    if (result.schema !== 'agent-access-active-v1') throw failure('The hub returned an invalid agent authentication.', 502);
    return result.active;
  }
  async sendMail(input: unknown, authorization: string) {
    if (this.hub) return this.hub.sendMail(input, authorization);
    const result = await this.member!.agentAccess({ schema: 'agent-access-hub-request-v1', operation: 'mail-send', input: AgentMailSendSchema.parse(input), authorization });
    if (result.schema !== 'agent-mail-sent-v1') throw failure('The hub returned an invalid mail receipt.', 502);
    return result;
  }
  async mailList(projectId: string, after: string | undefined, authorization: string) {
    if (this.hub) return this.hub.mailList(projectId, after, authorization);
    const result = await this.member!.agentAccess({ schema: 'agent-access-hub-request-v1', operation: 'mail-list', projectId,
      ...(after === undefined ? {} : { after }), authorization });
    if (result.schema !== 'agent-mail-list-v1') throw failure('The hub returned an invalid mail list.', 502);
    return result;
  }
}
