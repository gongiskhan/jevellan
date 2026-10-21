import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/notifications/editor';
const browser = { schema: 'notification-browser-facts-v1', secure: true, notification: true, push: true, serviceWorker: true, ownId: null as string | null };
const request = (facts: typeof browser | null = browser) => ({ schema: 'notification-editor-request-v1', browser: facts });
const endpoint = 'https://push.example/notification-editor-fixture';
const subscription = { schema: 'push-subscription-input-v1', endpoint, keys: { p256dh: 'fixture_public_key', auth: 'fixture_auth' }, label: 'Fixture browser' };

test('notification editor owns active matching, capabilities and action requests without exposing subscription keys', async () => {
  const f = fixture = await projectFixture();
  expect((await f.request('/api/notifications/subscriptions', 'POST', subscription)).status).toBe(200);
  const ownId = `push_${createHash('sha256').update(endpoint).digest('hex')}`;
  const response = await f.request(path, 'POST', request({ ...browser, ownId })); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'notification-editor-v1', active: true, canEnable: false, statusText: 'On for this device.',
    actions: { disable: { path: `/api/notifications/subscriptions/${ownId}`, method: 'DELETE', body: { schema: 'empty-request-v1' } }, test: { path: '/api/notifications/test', method: 'POST' } } });
  expect(view.devices).toHaveLength(1); expect(view.devices[0]).toMatchObject({ id: ownId, own: true, label: 'Fixture browser' });
  expect(JSON.stringify(view).includes('fixture_auth'), 'Subscription auth stays out of the editor.').toBe(false);
  expect(JSON.stringify(view).includes(endpoint), 'Subscription endpoints stay out of the editor.').toBe(false);
});

test('notification editor reports absent browser facts as unknown and supplies secure capability refusals', async () => {
  const f = fixture = await projectFixture(), unknown = await f.request(path, 'POST', request(null)); expect(unknown.status).toBe(200);
  expect(await unknown.json()).toMatchObject({ active: null, canEnable: false });
  for (const facts of [{ ...browser, secure: false }, { ...browser, push: false }, { ...browser, serviceWorker: false }, { ...browser, notification: false }]) {
    const response = await f.request(path, 'POST', request(facts)); expect(response.status).toBe(200); const view = await response.json(); expect(view.canEnable).toBe(false); expect(view.blockedReason).toBeTruthy();
  }
  const ready = await f.request(path, 'POST', request()); expect(ready.status).toBe(200); expect(await ready.json()).toMatchObject({ active: false, canEnable: true, statusText: 'Off for this device.', native: { workerWaitMs: 15000 } });
  expect((await f.request(path, 'POST', { ...request(), unexpected: true })).status).toBe(400);
});

test('browser subscription input derives its label server-side while retaining the existing id and old input contract', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/notifications/subscriptions', 'POST', { schema: 'push-subscription-input-v2', endpoint, keys: subscription.keys, userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit Safari/' });
  expect(response.status).toBe(200); const view = await response.json();
  expect(view.subscriptions).toHaveLength(1); expect(view.subscriptions[0]).toMatchObject({ id: `push_${createHash('sha256').update(endpoint).digest('hex')}`, label: 'Safari on macOS' });
  expect((await f.request('/api/notifications/subscriptions', 'POST', subscription)).status).toBe(200);
  expect((await (await f.request('/api/notifications/subscriptions')).json()).subscriptions[0].label).toBe('Fixture browser');
});

test('project notification metadata shares canonical choices, quiet-hour bounds and delivery help', async () => {
  const f = fixture = await projectFixture(), response = await f.request('/api/projects/project/config/editor'); expect(response.status).toBe(200); const view = await response.json();
  expect(view.notificationInfo, 'Project notification choices come from the engine.').toBeDefined();
  expect(view.notificationInfo).toMatchObject({ schema: 'project-notification-info-v1', quietHours: { timezoneMaxLength: 120 }, deviceHelp: 'Turn on notifications for this device in Settings → Notifications.' });
  expect(view.notificationInfo.levels.map((row: { value: string; label: string }) => [row.value, row.label])).toEqual([['everything', 'Everything'], ['standard', 'Standard'], ['needs-you', 'Only what needs me'], ['off', 'Off']]);
  expect(view.notificationInfo.quietHours.help).toBe('Updates wait until quiet hours end, then arrive as one summary. Urgent production questions arrive immediately.');
});

test('member notification editor uses the same subscription state and canonical removal plan', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  expect((await f.request('/api/notifications/subscriptions', 'POST', subscription)).status).toBe(200);
  const ownId = `push_${createHash('sha256').update(endpoint).digest('hex')}`, response = await member.request(path, 'POST', request({ ...browser, ownId })); expect(response.status).toBe(200); const view = await response.json();
  expect(view.active).toBe(true); expect(view.devices[0].own).toBe(true);
  const removed = await member.request(view.actions.disable.path, view.actions.disable.method, view.actions.disable.body); expect(removed.status).toBe(200);
  const after = await member.request(path, 'POST', request({ ...browser, ownId })); expect(after.status).toBe(200); expect(await after.json()).toMatchObject({ active: false, devices: [] });
});

test('coordinator choice help uses Projects vocabulary for its carried messages', async () => {
  const f = fixture = await projectFixture(), response = await f.request('/api/projects/project/coordinator/editor'); expect(response.status).toBe(200);
  expect((await response.json()).sessionHelp).toBe('A model or effort change starts a fresh session when needed. The project notebook and recent messages carry over.');
});

test('notification schemas retain older project forms and reject invalid browser facts', async () => {
  const { NotificationEditorRequestSchema, ProjectSettingsEditorSchema, notificationSubscriptionId } = await import('../packages/core/dist/index.js');
  const f = fixture = await projectFixture(), response = await f.request('/api/projects/project/config/editor'), view = await response.json();
  const { notificationInfo, ...old } = view; expect(notificationInfo).toBeDefined(); expect(ProjectSettingsEditorSchema.safeParse(old).success).toBe(true);
  expect(NotificationEditorRequestSchema.safeParse({ ...request(), browser: { ...browser, extra: true } }).success).toBe(false);
  expect(() => notificationSubscriptionId('not-a-digest')).toThrow();
});
