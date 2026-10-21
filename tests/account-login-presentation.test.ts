import type { RuntimeAdapter } from '../packages/runtime-contract/dist/index.js';
import { afterEach, expect, test } from 'vitest';
import { HubUnavailable, LoginViewSchema } from '../packages/core/dist/index.js';
import { accountEditorFixture } from './helpers/account-editor-fixture.js';
import { loginPresentationFixture } from './helpers/login-presentation-fixture.js';
import { projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });

test('account actions expose canonical writes and kind-safe deep-link plans without probing', async () => {
  f = await accountEditorFixture(); const before = await f.app.accounts.get('acc_fixture');
  const response = await f.request('/api/accounts/view'); expect(response.status).toBe(200); const view = await response.json();
  const row = view.runtimes.find((runtime: { id: string }) => runtime.id === 'fake').accounts.find((entry: { view: { account: { id: string } } }) => entry.view.account.id === 'acc_fixture');
  expect(row.actions.map((action: { id: string }) => action.id)).toEqual(['check', 'edit', 'toggle']);
  expect(row.actions.find((action: { id: string }) => action.id === 'toggle')).toMatchObject({ schema: 'account-action-v1', kind: 'write', path: '/hub/accounts/acc_fixture', method: 'PATCH', body: { schema: 'update-account-v1', revision: before.revision, enabled: false, label: before.account.label, ceilingPct: before.account.ceilingPct } });
  expect(row.deepLinkAction).toMatchObject({ id: 'login', kind: 'login', expected: { accountId: 'acc_fixture', deviceId: f.app.device.deviceId } });
  expect(row.devices.find((device: { id: string }) => device.id === f!.app.device.deviceId).loginPlan).toMatchObject({ id: 'login', path: `/api/accounts/acc_fixture/login?deviceId=${f.app.device.deviceId}` });
  expect(f.fake.runs).toHaveLength(0);
});

test('account actions direct endpoints to credential editing and API keys to key replacement', async () => {
  f = await accountEditorFixture(); const key = await f.app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', kind: 'api-key', label: 'Action key', paidUse: 'never', secret: 'fixture-action-key' });
  const endpoint = await f.app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', kind: 'endpoint', label: 'Action endpoint', secret: 'fixture-action-endpoint', endpoint: { baseUrl: 'https://api.example.test/anthropic', billing: 'free', models: [{ id: 'one', label: 'One', efforts: ['medium'], description: 'Fixture model' }] } });
  const view = await (await f.request('/api/accounts/view')).json(), rows = view.runtimes.find((runtime: { id: string }) => runtime.id === 'claude').accounts;
  expect(rows.find((entry: { view: { account: { id: string } } }) => entry.view.account.id === key.account.id).deepLinkAction).toMatchObject({ id: 'replace-key', kind: 'editor', mode: 'replace-key' });
  const row = rows.find((entry: { view: { account: { id: string } } }) => entry.view.account.id === endpoint.account.id);
  expect(row.actions.map((action: { id: string }) => action.id)).toEqual(['check', 'edit', 'toggle']); expect(row.deepLinkAction).toMatchObject({ id: 'edit', kind: 'editor', mode: 'edit' });
});

test('login presentation owns polling, code and cancellation plans and remains optional on legacy views', async () => {
  const fixture = await loginPresentationFixture(); f = fixture.f;
  const start = await f.request(`/api/accounts/${fixture.account.account.id}/login`, 'POST', { schema: 'login-start-v1', clientRequestId: 'login_presentation_start' }); expect(start.status).toBe(201); const view = await start.json();
  const path = `/api/logins/${view.id}?deviceId=${f.app.device.deviceId}`;
  expect(view.presentation).toMatchObject({ schema: 'account-login-presentation-v1', poll: { enabled: true, intervalMs: 1000, errorDelayMs: 2000, path }, code: { visible: true, label: 'Authorization code', plan: { path, method: 'POST' } }, close: { cancel: true, plan: { path, method: 'DELETE' } }, restart: { visible: false }, success: null });
  const { presentation: _presentation, ...legacy } = view; void _presentation; expect(LoginViewSchema.parse(legacy)).not.toHaveProperty('presentation'); expect(LoginViewSchema.safeParse({ ...view, presentation: { ...view.presentation, unexpected: true } }).success).toBe(false);
  const cancelled = await f.request(path, 'DELETE', { schema: 'empty-request-v1' }); expect(cancelled.status).toBe(200); expect(await cancelled.json()).toMatchObject({ state: 'cancelled', presentation: { poll: { enabled: false }, close: { cancel: false }, restart: { visible: true } } }); expect(fixture.cancelled()).toBe(1);
});

test('login presentation reports readiness separately from enabling and prepares a canonical enable save', async () => {
  const fixture = await loginPresentationFixture(); f = fixture.f; const account = fixture.account;
  await f.app.accounts.update(account.account.id, { schema: 'update-account-v1', revision: account.revision, label: account.account.label, enabled: false, ceilingPct: account.account.ceilingPct });
  const started = await (await f.request(`/api/accounts/${account.account.id}/login`, 'POST', { schema: 'login-start-v1', clientRequestId: 'login_disabled_start' })).json();
  const response = await f.request(`/api/logins/${started.id}`, 'POST', { schema: 'login-code-v1', code: 'fixture-code' }); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ state: 'done', presentation: { poll: { enabled: false }, success: { identityLine: 'Signed in as fixture@example.test', needsEnable: true, availabilityLine: 'Disabled.' } } });
  expect((await f.app.accounts.get(account.account.id)).account.enabled).toBe(false);
  const plan = view.presentation.success.enablePlan; const enabled = await f.request(plan.path, plan.method, { ...plan.body, clientRequestId: 'login_enable_account' }); expect(enabled.status).toBe(200);
  const refreshed = await (await f.request(`/api/logins/${started.id}`)).json(); expect(refreshed.presentation.success).toMatchObject({ needsEnable: false, availabilityLine: 'Ready.' });
});

test('remote login presentation keeps every operation bound to the original target device', async () => {
  f = await accountEditorFixture(); const member = await projectMember(f); let cancelled = 0;
  (member.fake as RuntimeAdapter).beginLogin = async () => ({ instructions: 'Remote fixture.', url: 'https://auth.example.test/authorize', poll: async () => 'pending', submitCode: async () => undefined, cancel: async () => { cancelled++; } });
  const start = await f.request(`/api/accounts/acc_fixture/login?deviceId=${member.deviceId}`, 'POST', { schema: 'login-start-v1', clientRequestId: 'remote_presentation_start' }); expect(start.status).toBe(201); const view = await start.json();
  const path = `/api/logins/${view.id}?deviceId=${member.deviceId}`;
  expect(view).toMatchObject({ deviceId: member.deviceId, presentation: { deviceLine: `On ${member.name}`, poll: { path }, code: { plan: { path } }, close: { plan: { path } }, restart: { plan: { path: `/api/accounts/acc_fixture/login?deviceId=${member.deviceId}` } } } });
  expect((await f.request(path, 'DELETE', { schema: 'empty-request-v1' })).status).toBe(200); expect(cancelled).toBe(1);
});

test.each(['start', 'code'] as const)('login presentation read loss after accepted %s retains retry admission and provider receipts', async stage => {
  const fixture = await loginPresentationFixture(); f = fixture.f;
  const path = `/api/accounts/${fixture.account.account.id}/login`, input = { schema: 'login-start-v1', clientRequestId: 'presentation_lost_read' };
  const first = stage === 'code' ? await (await f.request(path, 'POST', input)).json() : undefined;
  const present = f.app.loginPresentation.bind(f.app); let lost = false;
  f.app.loginPresentation = async (...args) => { if (!lost) { lost = true; throw new HubUnavailable('Fixture'); } return present(...args); };
  const target = first ? `/api/logins/${first.id}` : path, body = first ? { schema: 'login-code-v1', code: 'fixture-one-approval' } : input;
  const interrupted = await f.request(target, 'POST', body); expect(interrupted.status).toBe(503); expect(await interrupted.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const retried = await f.request(target, 'POST', body); expect(retried.status).toBe(first ? 200 : 201);
  expect(await retried.json()).toMatchObject({ state: first ? 'done' : 'pending', presentation: { schema: 'account-login-presentation-v1' } });
  expect(fixture.counts).toEqual({ starts: 1, submissions: first ? 1 : 0 });
});
