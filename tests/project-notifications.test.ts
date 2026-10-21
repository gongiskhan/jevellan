import { afterEach, expect, test } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import webpush from 'web-push';
import { Homes, ErrorDocumentSchema, PushSubscriptionSchema, ProjectNotificationSchema, PushDeliverySchema, NotificationsViewSchema, ThreadCreatedViewSchema, SecretRedactor, type ProjectNotification } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { HubNotifications, notificationAllowed, type PushSend } from '../apps/daemon/dist/notifications.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
const roots: string[] = [], hubs: HubDatabase[] = [], services: HubNotifications[] = []; let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; for (const service of services.splice(0)) await service.close(); for (const hub of hubs.splice(0)) hub.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(send: PushSend = async () => ({ statusCode: 201, body: '', headers: {} }), now = Date.now) {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-push-')); roots.push(root); mkdirSync(join(root, 'user')); const hub = new HubDatabase(new Homes(join(root, 'data'), join(root, 'user')), 'hub', new SecretRedactor()); hubs.push(hub);
  const service = new HubNotifications(hub, () => 'https://fixture.example', send, now); services.push(service); return { hub, service };
}
function subscribe(service: HubNotifications, endpoint = 'https://push.example/one') {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  return service.request({ schema: 'notifications-owner-request-v1', operation: 'subscribe', ownerSession: 'fixture', input: { schema: 'push-subscription-input-v1', endpoint, label: 'Fixture browser', keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } });
}
function notification(id: string, at: number, kind: ProjectNotification['kind'] = 'test'): ProjectNotification {
  return { schema: 'project-notification-v1', revision: 0, id, projectId: kind === 'test' ? null : 'project', kind, title: 'Fixture', body: id, url: '/projects/project', tag: 'fixture', createdAt: new Date(at).toISOString() };
}
test('notification levels filter every kind without affecting the test notification', () => {
  for (const level of ['everything', 'standard', 'needs-you', 'off']) for (const kind of ProjectNotificationSchema.shape.kind.options) {
    const expected = kind === 'test' || level === 'everything' || level === 'standard' && kind !== 'thread-finished' || level === 'needs-you' && ['needs-you', 'thread-failed', 'coordinator-unavailable', 'deploy', 'quiet-summary'].includes(kind);
    expect(notificationAllowed(kind, level), `${level}:${kind}`).toBe(expected);
  }
});
test('quiet hours hold every update durably and flush one project summary while urgent production questions bypass', async () => {
  const { ProjectWorkSettingsSchema, defaultProjectWorkSettings } = await import('../packages/core/dist/index.js');
  let now = Date.parse('2026-10-19T22:30:00.000Z'); const sent: Array<{ body: string }> = [];
  const send: PushSend = async (_subscription, payload) => { sent.push(JSON.parse(String(payload))); return { statusCode: 201, body: '', headers: {} }; };
  const { hub, service } = setup(send, () => now); subscribe(service);
  hub.put('project-work-settings', 'project', ProjectWorkSettingsSchema, ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('project'), notifications: { level: 'standard', quietHours: { enabled: true, start: '23:00', end: '08:00', timezone: 'Europe/Lisbon' } } }), 0);
  service.enqueue(notification('one', now, 'coordinator-reply')); service.enqueue(notification('two', now, 'coordinator-reply'));
  service.enqueue({ ...notification('urgent', now, 'needs-you'), body: 'production broken', urgent: true });
  await service.sweep(); expect(sent.map(row => row.body)).toEqual(['production broken']);
  await service.close();
  const restarted = new HubNotifications(hub, () => 'https://fixture.example', send, () => now); services.push(restarted);
  now = Date.parse('2026-10-20T07:01:00.000Z'); await restarted.sweep(); await restarted.sweep();
  expect(sent.map(row => row.body)).toEqual(['production broken', '2 updates while you were away']);
});
test('legacy notification levels migrate with disabled Lisbon quiet hours', async () => {
  const { StoredProjectWorkSettingsSchema, defaultProjectWorkSettings } = await import('../packages/core/dist/index.js');
  expect(StoredProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('project'), notifications: 'needs-you' }).notifications).toEqual({ level: 'needs-you', quietHours: { enabled: false, start: '23:00', end: '08:00', timezone: 'Europe/Lisbon' } });
});
test('disabling quiet hours flushes held updates immediately and urgent ask-user survives the bridge input', async () => {
  const { AskUserInputSchema, ProjectWorkSettingsSchema, defaultProjectWorkSettings } = await import('../packages/core/dist/index.js');
  const f = fixture = await projectFixture(), sent: Array<{ body: string }> = [];
  const service = new HubNotifications(f.app.hub, () => 'https://fixture.example', async (_subscription, payload) => { sent.push(JSON.parse(String(payload))); return { statusCode: 201, body: '', headers: {} }; }); services.push(service); subscribe(service);
  const preferences = { level: 'standard', quietHours: { enabled: true, start: '00:00', end: '00:00', timezone: 'Europe/Lisbon' } };
  await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('project'), notifications: preferences }), 0);
  await f.app.projectWork.decisions.ask('project', { question: 'An ordinary question.' }, 'coordinator', 'quiet_question');
  await f.app.projectWork.decisions.ask('project', AskUserInputSchema.parse({ question: 'Production is broken.', urgent: true }), 'coordinator', 'urgent_question');
  await service.sweep(); expect(sent.map(row => row.body)).toEqual(['Production is broken.']);
  const current = (await f.app.projectHub.settings('project'))!;
  await f.app.projectHub.putSettings({ ...current.document, notifications: { ...current.document.notifications, quietHours: { ...current.document.notifications.quietHours, enabled: false } } }, current.revision);
  await service.sweep(); expect(sent.map(row => row.body)).toEqual(['Production is broken.', '1 updates while you were away']);
});
test('quiet hours handle daytime boundaries, overnight clocks and the Lisbon offset change', async () => {
  const { insideQuietHours } = await import('../apps/daemon/dist/notifications.js');
  const hours = { enabled: true, start: '23:00', end: '08:00', timezone: 'Europe/Lisbon' };
  expect(insideQuietHours(Date.parse('2026-10-19T22:00:00Z'), hours)).toBe(true);
  expect(insideQuietHours(Date.parse('2026-10-19T07:00:00Z'), hours)).toBe(false);
  expect(insideQuietHours(Date.parse('2026-10-26T22:00:00Z'), hours)).toBe(false);
  expect(insideQuietHours(Date.parse('2026-10-26T23:00:00Z'), hours)).toBe(true);
  expect(insideQuietHours(Date.parse('2026-10-19T12:00:00Z'), { ...hours, start: '09:00', end: '17:00' })).toBe(true);
});
test('VAPID keys are lazy, encrypted, stable across service restarts and absent from the owner view', () => {
  const { hub, service } = setup(); expect(() => hub.vault.forLaunch('web-push')).toThrow('Saved secret is unavailable.');
  const view = service.request({ schema: 'notifications-owner-request-v1', operation: 'view', ownerSession: 'fixture' });
  const saved = JSON.parse(hub.vault.forLaunch('web-push')) as { privateKey: string };
  expect(hub.redactor.text(saved.privateKey)).not.toContain(saved.privateKey); expect(JSON.stringify(view)).not.toContain(saved.privateKey);
  const second = new HubNotifications(hub, () => 'https://fixture.example'); services.push(second);
  expect(second.request({ schema: 'notifications-owner-request-v1', operation: 'view', ownerSession: 'fixture' }).publicKey).toBe(view.publicKey);
});
test('a real encrypted Web Push request reaches a fake push service with VAPID and TTL', async () => {
  const requests: Array<{ headers: import('node:http').IncomingHttpHeaders; bytes: Buffer }> = [];
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push({ headers: request.headers, bytes: Buffer.concat(chunks) }); response.writeHead(201); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/push`;
  try {
    const { hub, service } = setup(async (sub, payload, options) => {
      const request = webpush.generateRequestDetails(sub, String(payload), options);
      const result = await fetch(request.endpoint, { method: request.method, headers: request.headers as Record<string, string>, body: new Uint8Array(request.body!).buffer });
      return { statusCode: result.status, body: '', headers: {} };
    });
    subscribe(service, endpoint); service.enqueue(notification('encrypted_fixture', Date.now())); await service.sweep();
    expect(requests).toHaveLength(1); expect(requests[0]!.headers.authorization).toMatch(/^vapid /u); expect(requests[0]!.headers['content-encoding']).toBe('aes128gcm'); expect(requests[0]!.headers.ttl).toBe('3600');
    expect(requests[0]!.bytes.length).toBeGreaterThan(100); expect(requests[0]!.bytes.toString()).not.toContain('encrypted_fixture');
    expect(hub.list('project-notifications', ProjectNotificationSchema)[0]!.document.sentAt).toBeDefined();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('a410 removes a subscription, while transient failures retry after10,60 and300seconds across restart', async () => {
  let now = Date.now(), attempts = 0; const { hub, service } = setup(async () => { attempts++; throw Object.assign(new Error('temporary'), { statusCode: attempts === 1 ? 410 : 503 }); }, () => now);
  subscribe(service); service.enqueue(notification('gone', now)); await service.sweep(); expect(hub.list('push-subscriptions', PushSubscriptionSchema)).toHaveLength(0);
  subscribe(service); service.enqueue(notification('retry', now)); await service.sweep(); expect(attempts).toBe(2);
  const restarted = new HubNotifications(hub, () => 'https://fixture.example', async () => { attempts++; throw Object.assign(new Error('temporary'), { statusCode: 503 }); }, () => now); services.push(restarted);
  await restarted.sweep(); expect(attempts).toBe(2);
  for (const delay of [10_000, 60_000, 300_000]) { now += delay; await restarted.sweep(); }
  expect(attempts).toBe(5); expect(hub.get('project-notifications', 'retry', ProjectNotificationSchema)?.document.dropped).toContain('No subscription'); expect(hub.list('push-subscriptions', PushSubscriptionSchema)[0]!.document.failures).toBe(4);
});
test('one successful browser does not suppress another browser retry, and a new browser receives no sent history', async () => {
  let now = Date.now(), second = 0; const seen: string[] = []; const { hub, service } = setup(async sub => { seen.push(sub.endpoint); if (sub.endpoint.endsWith('two') && second++ === 0) throw Object.assign(new Error('temporary'), { statusCode: 503 }); return { statusCode: 201, body: '', headers: {} }; }, () => now);
  subscribe(service); subscribe(service, 'https://push.example/two'); service.enqueue(notification('mixed', now)); await service.sweep(); expect(hub.get('project-notifications', 'mixed', ProjectNotificationSchema)?.document.sentAt).toBeDefined();
  subscribe(service, 'https://push.example/three'); now += 10_000; await service.sweep(); expect(seen.filter(url => url.endsWith('one'))).toHaveLength(1); expect(seen.filter(url => url.endsWith('two'))).toHaveLength(2); expect(seen.filter(url => url.endsWith('three'))).toHaveLength(0);
});
test('coordinator replies coalesce, keep the newest at equal times and send at most once in30seconds', async () => {
  let now = Date.now(); const sent: string[] = []; const { hub, service } = setup(async (_sub, payload) => { sent.push(JSON.parse(String(payload)).body); return { statusCode: 201, body: '', headers: {} }; }, () => now); subscribe(service);
  service.enqueue(notification('first', now, 'coordinator-reply')); service.enqueue(notification('second', now, 'coordinator-reply')); await service.sweep(); expect(sent).toEqual(['second']);
  now += 5000; service.enqueue(notification('third', now, 'coordinator-reply')); await service.sweep(); expect(sent).toHaveLength(1);
  now += 25_000; await service.sweep(); expect(sent).toEqual(['second', 'third']);
  now += 8 * 86400000; await service.sweep(); expect(hub.list('project-notifications', ProjectNotificationSchema)).toHaveLength(0); expect(hub.list('push-deliveries', PushDeliverySchema)).toHaveLength(0);
});
test('owner subscription API authenticates, stores no returned secrets and accepts idempotent retries', async () => {
  const f = fixture = await projectFixture();
  const input = { schema: 'push-subscription-input-v1', endpoint: 'https://push.example/fixture', keys: { p256dh: 'fixture_public_key', auth: 'fixture_auth' }, label: 'Fixture' };
  const a = await f.json('/api/notifications/subscriptions', NotificationsViewSchema, 'POST', input), b = await f.json('/api/notifications/subscriptions', NotificationsViewSchema, 'POST', input);
  expect(a.subscriptions[0]?.id).toBe(b.subscriptions[0]?.id); expect(a.subscriptions).toHaveLength(1); expect(JSON.stringify(a)).not.toContain('fixture_auth');
  expect((await fetch(f.base + '/api/notifications/subscriptions')).status).toBe(401);
  const removed = await f.json('/api/notifications/subscriptions/' + a.subscriptions[0]!.id, NotificationsViewSchema, 'DELETE', { schema: 'empty-request-v1' }); expect(removed.subscriptions).toHaveLength(0);
});
test('canonical thread reports and failures create one durable notification each, including restart replay', async () => {
  const f = fixture = await projectFixture(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'A narrow change is ready.\nExtra detail.' }), forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'notify_thread', title: 'A small task', task: 'Do a small task.', modelId: 'fixture', isolation: 'worktree' });
  await f.app.projectWork.idle(); await f.app.projectWork.notifications.flush();
  f.app.projectWork.ledgers.thread('project', created.threadId).append({ type: 'thread-state', data: { schema: 'thread-state-v1', from: 'idle', to: 'failed', reason: 'The narrow command failed.', changed: ['state'] } });
  await f.app.projectWork.notifications.flush(); const records = f.app.hub.list('project-notifications', ProjectNotificationSchema).map(row => row.document);
  expect(records.filter(row => row.kind === 'thread-finished')).toHaveLength(1); expect(records.find(row => row.kind === 'thread-finished')?.body).toBe('A narrow change is ready.');
  expect(records.find(row => row.kind === 'thread-failed')).toMatchObject({ title: `${f.project.name}: A small task`, body: 'Failed: The narrow command failed.' });
  await f.restart(); expect(f.app.hub.list('project-notifications', ProjectNotificationSchema)).toHaveLength(records.length);
});


test('coordinator replies strip Markdown, uncounted retries do not notify failure and the second counted failure notifies once', async () => {
  const f = fixture = await projectFixture(); const ledger = f.app.projectWork.ledgers.coordinator('project');
  ledger.append({ type: 'coordinator-text', turn: 1, data: { schema: 'coordinator-text-v1', text: '**Ready** [pull request](https://example.invalid/pr). Keep SANDBOX_DATA_DIR and `__version__`; 2 > 1.' } });
  for (const [turn, retrying, status] of [[1, false, 'failed'], [2, true, 'failed'], [3, false, 'interrupted'], [4, false, 'failed'], [5, false, 'failed']] as const)
    ledger.append({ type: 'coordinator-turn-end', turn, data: { schema: 'coordinator-turn-end-v1', turn, retrying, status, error: 'Provider unavailable.' } });
  await f.app.projectWork.notifications.flush(); const docs = f.app.hub.list('project-notifications', ProjectNotificationSchema).map(row => row.document);
  expect(docs.filter(row => row.kind === 'coordinator-reply')).toHaveLength(1); expect(docs.find(row => row.kind === 'coordinator-reply')?.body).toBe('Ready pull request. Keep SANDBOX_DATA_DIR and __version__; 2 > 1.');
  expect(docs.filter(row => row.kind === 'coordinator-unavailable'), JSON.stringify(docs.map(row => row.kind))).toHaveLength(1); expect(docs.find(row => row.kind === 'coordinator-unavailable')?.body).toBe('The coordinator stopped: Provider unavailable.');
  await f.restart(); expect(f.app.hub.list('project-notifications', ProjectNotificationSchema)).toHaveLength(docs.length);
});
test('an owner message after the coordinator stopped starts a new count, so failing again after a restart notifies again', async () => {
  const f = fixture = await projectFixture(); const ledger = f.app.projectWork.ledgers.coordinator('project');
  const fail = (turn: number) => ledger.append({ type: 'coordinator-turn-end', turn, data: { schema: 'coordinator-turn-end-v1', turn, status: 'failed', error: 'Rigging preserved local changes: settings.json.' } });
  fail(1); fail(2);
  ledger.append({ type: 'coordinator-event', data: { schema: 'coordinator-event-v1', kind: 'user-message', id: 'cev_restart', at: new Date().toISOString(), text: 'Carry on.', clientMessageId: 'owner_restart_1', via: 'bridge' } });
  fail(3); fail(4); fail(5);
  await f.app.projectWork.notifications.flush();
  const stopped = () => f.app.hub.list('project-notifications', ProjectNotificationSchema).map(row => row.document).filter(row => row.kind === 'coordinator-unavailable');
  expect(stopped().map(row => row.body)).toEqual(['The coordinator stopped: Rigging preserved local changes: settings.json.', 'The coordinator stopped: Rigging preserved local changes: settings.json.']);
  await f.restart(); expect(stopped()).toHaveLength(2);
});

test('a coordinator that stopped and runs again says so once, and a completed turn without a stop says nothing about recovery', async () => {
  const f = fixture = await projectFixture(); const ledger = f.app.projectWork.ledgers.coordinator('project');
  const end = (turn: number, status: 'failed' | 'completed') => ledger.append({ type: 'coordinator-turn-end', turn, data: { schema: 'coordinator-turn-end-v1', turn, status, ...(status === 'failed' ? { error: 'Provider unavailable.' } : {}) } });
  end(1, 'completed'); end(2, 'failed'); end(3, 'failed');
  // The owner's restart starts a new failure count; the turn after it still reports the recovery.
  ledger.append({ type: 'coordinator-event', data: { schema: 'coordinator-event-v1', kind: 'user-message', id: 'cev_restart', at: new Date().toISOString(), text: 'Carry on.', clientMessageId: 'owner_restart_1', via: 'bridge' } });
  end(4, 'completed'); end(5, 'completed');
  await f.app.projectWork.notifications.flush();
  // General lists sort by hashed id. This assertion verifies the causal stop/recovery sequence.
  const rows = f.app.hub.listByField('project-notifications', 'projectId', 'project', ProjectNotificationSchema, { order: 'insertion-desc' }).reverse().map(row => row.document).filter(row => row.kind === 'coordinator-unavailable');
  expect(rows.map(row => row.body)).toEqual(['The coordinator stopped: Provider unavailable.', 'The coordinator is running again.']);
});

test('a question creates a single needs-you notification and uses high urgency', async () => {
  const f = fixture = await projectFixture(); const sent: string[] = [];
  const service = new HubNotifications(f.app.hub, () => 'https://fixture.example', async (_sub, payload, options) => { sent.push(String(payload)); expect(options?.urgency).toBe('high'); return { statusCode: 201, body: '', headers: {} }; }); services.push(service); subscribe(service);
  await f.app.projectWork.decisions.ask('project', { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Amber' }] }, 'coordinator', 'question_fixture');
  await service.sweep(); await service.sweep(); expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toMatchObject({ title: `${f.project.name}: question`, body: 'Which colour?', url: '/projects/project?view=overview' });
});


test('member devices forward owner subscriptions and retain notification delivery through a hub outage', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  const view = await member.json('/api/notifications/subscriptions', NotificationsViewSchema, 'POST', { schema: 'push-subscription-input-v1', endpoint: 'https://push.example/member', keys: { p256dh: 'fixture_public', auth: 'fixture_auth' }, label: 'Member browser' });
  expect(view.subscriptions).toHaveLength(1); expect(f.app.hub.list('push-subscriptions', PushSubscriptionSchema)).toHaveLength(1);
  member.offline = true;
  member.app.projectWork.ledgers.coordinator('project').append({ type: 'coordinator-text', turn: 1, data: { schema: 'coordinator-text-v1', text: 'Member report ready.' } });
  member.app.projectWork.ledgers.coordinator('project').append({ type: 'coordinator-turn-end', turn: 1, data: { schema: 'coordinator-turn-end-v1', turn: 1, status: 'completed' } });
  await expect(member.app.projectWork.notifications.flush()).rejects.toThrow(); member.offline = false;
  await member.app.projectWork.notifications.flush(); const notifications = f.app.hub.list('project-notifications', ProjectNotificationSchema).map(row => row.document);
  expect(notifications.filter(row => row.body === 'Member report ready.')).toHaveLength(1);
  await member.app.projectWork.notifications.flush(); expect(f.app.hub.list('project-notifications', ProjectNotificationSchema)).toHaveLength(notifications.length);
});


test('a lost test-notification reply is not advertised as safely retryable', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  member.loseReply = call => call.includes('notifications') && call.endsWith('test');
  const response = await member.request('/api/notifications/test', 'POST', { schema: 'empty-request-v1' });
  expect(response.status).toBe(503); const error = ErrorDocumentSchema.parse(await response.json()); expect(error.retryable).not.toBe(true);
  expect(f.app.hub.list('project-notifications', ProjectNotificationSchema).filter(row => row.document.kind === 'test')).toHaveLength(1);
});

test('shutdown finishes its in-flight send and leaves the rest durable for the next hub start', async () => {
  let release!: () => void, started!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; }); let attempts = 0;
  const { hub, service } = setup(async () => { attempts++; started(); await pending; return { statusCode: 201, body: '', headers: {} }; });
  subscribe(service); service.enqueue(notification('shutdown_first', Date.now())); service.enqueue(notification('shutdown_second', Date.now()));
  const sweep = service.sweep(); await entered; const closing = service.close(); release(); await closing; await sweep; expect(attempts).toBe(1);
  const restarted = new HubNotifications(hub, () => 'https://fixture.example', async () => { attempts++; return { statusCode: 201, body: '', headers: {} }; }); services.push(restarted);
  await restarted.sweep(); expect(attempts).toBe(2); expect(hub.list('project-notifications', ProjectNotificationSchema).every(row => row.document.sentAt)).toBe(true);
});
