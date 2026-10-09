import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Homes, ProjectSchema, ThreadIndexSchema, type CoordinatorEvent } from '../packages/core/dist/index.js';
import { HubAgentAccess, HubDatabase, HubProjectAccess, HubProjectStore } from '../packages/mesh/dist/index.js';
import { MailService, eventLine } from '../packages/projects/dist/index.js';

let root: string; let hub: HubDatabase; let access: HubAgentAccess; let authorization: string; let now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-agent-mail-')); mkdirSync(join(root, 'user'));
  hub = new HubDatabase(new Homes(join(root, 'home'), join(root, 'user')), 'hub');
  now = Date.now(); access = new HubAgentAccess(hub, () => now);
  for (const id of ['allowed', 'other']) hub.put('projects', id, ProjectSchema, { schema: 'project-v1', id, name: id, paths: {},
    branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
  const created = access.create({ schema: 'agent-access-create-v1', clientRequestId: 'connect', label: 'Planning agent', projectIds: ['allowed'] });
  authorization = `Bearer ${created.token}`;
  const store = new HubProjectStore(hub, 'owner', () => now);
  for (const [id, isolation, state] of [['main', 'main', 'running'], ['worktree', 'worktree', 'running'], ['ended', 'main', 'done']] as const) {
    store.publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id, projectId: 'allowed', title: id, state, isolation,
      ownerDeviceId: 'owner', runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Fixture', turns: 1,
      createdAt: new Date(now - 1000).toISOString(), updatedAt: new Date(now).toISOString() }), 1);
  }
});
afterEach(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
const input = (clientRequestId = 'message') => ({ schema: 'agent-mail-send-v1', projectId: 'allowed', clientRequestId, to: 'main', subject: 'Coordination', body: 'Please finish the requested work.' });

test('external mail keeps its sender identity, retries once, and cannot impersonate a worker', async () => {
  const first = access.sendMail(input(), authorization);
  expect(first.mail.from).toBe(access.authenticateBearer(authorization)!.connectionId);
  expect(first.mail.fromTitle).toBe('External agent: Planning agent');
  now += 1000;
  expect(access.sendMail(input(), authorization)).toEqual({ ...first, repeated: true });
  expect(() => access.sendMail({ ...input(), body: 'Different task' }, authorization)).toThrow('already used');
  expect(() => access.sendMail({ ...input(), from: 'coordinator' }, authorization)).toThrow();
  const store = new HubProjectAccess(hub, 'owner', () => now);
  const service = new MailService({ hub: store, toCoordinator: async () => {}, local: () => undefined, now: () => now });
  const inbox = await service.threadTool({ kind: 'thread', projectId: 'allowed', threadId: 'main', turn: 1, isolation: 'main' }, 'jevellan_mail_inbox', {});
  expect(inbox).toMatchObject({ mail: [{ from: first.mail.from, fromTitle: 'External agent: Planning agent', body: input().body }] });
});

test('mail enforces grant scope, actual Main recipients and revocation at the hub', () => {
  expect(() => access.sendMail({ ...input(), projectId: 'other' }, authorization)).toThrow('cannot access');
  for (const to of ['worktree', 'ended', 'missing']) expect(() => access.sendMail({ ...input(), to }, authorization)).toThrow('active Main');
  expect(() => access.mailList('other', undefined, authorization)).toThrow('cannot access');
  access.revoke(access.authenticateBearer(authorization)!.connectionId);
  expect(() => access.sendMail(input(), authorization)).toThrow('revoked');
  expect(() => access.mailList('allowed', undefined, authorization)).toThrow('revoked');
});

test('project mail pages are bounded and viewing them does not consume a thread inbox', () => {
  for (let index = 0; index < 105; index++) access.sendMail(input(`request_${index}`), authorization);
  const page = access.mailList('allowed', undefined, authorization);
  expect(page.mail).toHaveLength(100); expect(page.next).not.toBeNull();
  const tail = access.mailList('allowed', page.next!, authorization);
  expect(tail.mail).toHaveLength(5); expect(tail.next).toBeNull();
  expect(new Set([...page.mail, ...tail.mail].map(mail => mail.id)).size).toBe(105);
  expect(new HubProjectStore(hub, 'owner', () => now).inbox('allowed', 'main').records).toHaveLength(100);
  expect(page.mail.every(mail => !mail.readBy.length)).toBe(true);
});

test('coordinator mail delivery retries retain a stable event and show the external sender', async () => {
  const receipt = access.sendMail({ ...input(), to: 'coordinator' }, authorization);
  const events: CoordinatorEvent[] = [];
  const service = new MailService({ hub: new HubProjectAccess(hub, 'owner', () => now), toCoordinator: async (_projectId, event) => { events.push(event); }, local: () => undefined, now: () => now });
  await service.deliverExternal(receipt.mail); await service.deliverExternal(receipt.mail);
  expect(events[0]).toEqual(events[1]);
  expect(eventLine(events[0]!, { title: () => 'Unknown thread', base: 'main' })).toContain('External agent: Planning agent');
  expect(receipt.mail.to).toBe('coordinator');
});
