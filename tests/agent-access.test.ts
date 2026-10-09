import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Homes, ProjectSchema } from '../packages/core/dist/index.js';
import { HubAgentAccess, HubDatabase, UiAuth, assertAgentProject } from '../packages/mesh/dist/index.js';

let root: string; let hub: HubDatabase; let access: HubAgentAccess; let now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-agent-access-')); mkdirSync(join(root, 'user'));
  hub = new HubDatabase(new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), 'hub');
  now = Date.now(); access = new HubAgentAccess(hub, () => now);
});
afterEach(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
const request = (clientRequestId = `create_${randomUUID()}`) => ({ schema: 'agent-access-create-v1', clientRequestId, label: 'External test agent' });
function project(id: string) {
  hub.put('projects', id, ProjectSchema, { schema: 'project-v1', id, name: id, paths: {}, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
}

// Capability regressions: isolated capabilities, wrong/empty token rejection, concurrent first issuance, 0600 material.
test('agent tokens persist encrypted, authenticate after reopening, and redact from every later view', () => {
  const created = access.create(request()); const token = created.token!;
  expect(access.authenticateBearer(`Bearer ${token}`)).toMatchObject({ connectionId: created.connection.id, label: created.connection.label });
  expect(access.authenticateBearer('Bearer wrong')).toBeNull(); expect(access.authenticateBearer(undefined)).toBeNull();
  expect(access.authenticateBearer(`Bearer ${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`)).toBeNull();
  expect(access.authenticateBearer(token)).toBeNull();
  const documents = JSON.stringify(hub.db.prepare('SELECT document FROM documents').all());
  const vault = JSON.stringify(hub.db.prepare('SELECT document FROM secrets').all());
  expect(documents).not.toContain(token); expect(vault).not.toContain(token); expect(JSON.stringify(access.list())).not.toContain(token);
  expect(hub.redactor.text(`Connection ${token}`)).toBe('Connection [redacted]');
  expect(statSync(join(root, 'user', '.jevellan', 'hub', 'secret.key')).mode & 0o777).toBe(0o600);
  hub.close(); hub = new HubDatabase(new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), 'hub'); access = new HubAgentAccess(hub, () => now);
  expect(access.authenticateBearer(`Bearer ${token}`)?.connectionId).toBe(created.connection.id);
  expect(hub.redactor.text(token)).toBe('[redacted]');
});
test('issuance retries create one connection and never reveal its saved token again', async () => {
  const input = request('one_request'); const replies = await Promise.all(Array.from({ length: 12 }, async () => access.create(input)));
  expect(new Set(replies.map(reply => reply.connection.id)).size).toBe(1);
  expect(replies.filter(reply => reply.created && reply.token)).toHaveLength(1);
  expect(replies.slice(1).every(reply => !reply.created && reply.token === undefined)).toBe(true);
  expect(hub.db.prepare('SELECT count(*) AS total FROM secrets').get()?.total).toBe(1);
  expect(() => access.create({ ...input, label: 'Other request' })).toThrow('already used');
});
test('revocation and expiry stop authentication and active streams without restoring tokens', () => {
  const created = access.create({ ...request(), expiresAt: new Date(now + 1000).toISOString() });
  expect(access.isActive(created.connection.id)).toBe(true); now += 1000;
  expect(access.authenticateBearer(`Bearer ${created.token}`)).toBeNull(); expect(access.isActive(created.connection.id)).toBe(false);
  const another = access.create(request()); const revoked = access.revoke(another.connection.id);
  expect(revoked.revokedAt).toBeDefined(); expect(access.revoke(another.connection.id)).toEqual(revoked);
  expect(access.authenticateBearer(`Bearer ${another.token}`)).toBeNull(); expect(access.isActive(another.connection.id)).toBe(false);
  expect(hub.db.prepare('SELECT count(*) AS total FROM secrets').get()?.total).toBe(1);
  expect(() => access.create({ ...request(), expiresAt: new Date(now).toISOString() })).toThrow('future');
});
test('project scope is validated at creation and applied to every scoped grant', () => {
  project('allowed'); project('denied');
  expect(() => access.create({ ...request(), projectIds: ['missing'] })).toThrow('does not exist');
  const created = access.create({ ...request(), projectIds: ['allowed'] }); const grant = access.authenticateBearer(`Bearer ${created.token}`)!;
  expect(grant.projectIds).toEqual(['allowed']); expect(() => assertAgentProject(grant, 'allowed')).not.toThrow();
  expect(() => assertAgentProject(grant, 'denied')).toThrow('cannot access');
  const global = access.create(request()); expect(() => assertAgentProject(access.authenticateBearer(`Bearer ${global.token}`)!, 'denied')).not.toThrow();
});
test('member management requires an owner session for the authenticated source device', async () => {
  const auth = new UiAuth(hub, hub.vault, 'hub'); const owner = await auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
  expect(() => access.request({ schema: 'agent-access-hub-request-v1', operation: 'create', input: request(), ownerSession: owner }, 'member', auth)).toThrow('Sign in');
  const memberOwner = await auth.login({ schema: 'passphrase-input-v1', passphrase: 'incorrect-fixture' }, 'test', 'member').catch(() => null);
  expect(memberOwner).toBeNull();
  const created = access.request({ schema: 'agent-access-hub-request-v1', operation: 'create', input: request(), ownerSession: owner }, 'hub', auth);
  expect(created.schema).toBe('agent-access-created-v1');
  auth.logout(owner);
  expect(() => access.request({ schema: 'agent-access-hub-request-v1', operation: 'list', ownerSession: owner }, 'hub', auth)).toThrow('Sign in');
});
