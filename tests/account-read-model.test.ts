import { afterEach, expect, test } from 'vitest';
import { AccountSchema, AccountStatusSchema } from '../packages/core/dist/index.js';
import { HubAccounts } from '../packages/mesh/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
function seed(id: string, options: { shared?: boolean; paid?: boolean } = {}) {
  const app = f!.app;
  app.hub.put('accounts', id, AccountSchema, { schema: 'account-v2', id, runtime: 'fake', label: id, kind: options.paid ? 'api-key' : 'subscription', enabled: true, credential: options.shared || options.paid ? 'shared' : 'per-device', ceilingPct: 90, ...(options.paid ? { paidUse: 'when-subscriptions-run-out' } : {}) }, 0);
  const store = new HubAccounts(app.hub, app.device.deviceId);
  store.writeStatus(AccountStatusSchema.parse({ ...store.status(id), auth: 'ready', observedAt: new Date().toISOString() }), null);
  return store;
}

test('account read model shares launch eligibility, expired usage and server-clock cooling notices', async () => {
  f = await projectFixture(); const store = seed('expired_usage'); seed('paid_fallback', { paid: true }); const now = Date.now();
  store.writeStatus({ ...store.status('expired_usage'), usage: { source: 'probe', observedAt: new Date(now - 10000).toISOString(), fiveHourPct: 100, fiveHourResetsAt: new Date(now - 1000).toISOString() }, modelCooling: { cooled: new Date(now + 600000).toISOString(), expired: new Date(now - 1000).toISOString() } }, null);
  const response = await f.request('/api/accounts/view'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'accounts-settings-view-v1', currentDeviceId: f.app.device.deviceId, refreshMs: 30000 });
  const runtime = view.runtimes.find((row: { id: string }) => row.id === 'fake');
  expect(runtime.models).toEqual([]); expect(runtime.emptyModelsText).toBe('Models appear after an account is checked.');
  const rows = runtime.accounts;
  expect(rows.find((row: { view: { account: { id: string } } }) => row.view.account.id === 'expired_usage')).toMatchObject({ availability: { eligible: true, reason: 'eligible', label: 'Some models cooling' }, usage: [{ key: 'fiveHour', value: null, resetAt: null }, { key: 'weekly', value: null }], notices: [expect.objectContaining({ id: 'model:cooled' })] });
  expect(rows.find((row: { view: { account: { id: string } } }) => row.view.account.id === 'paid_fallback')).toMatchObject({ availability: { eligible: false, reason: 'paid-not-allowed', label: 'Paid use not allowed' } });
  expect(f.fake.runs).toHaveLength(0);
});

test('account read model keeps authenticated member identity and per-device status distinct', async () => {
  f = await projectFixture(); seed('shared_ready', { shared: true }); const member = await projectMember(f);
  const response = await member.request('/api/accounts/view'); expect(response.status).toBe(200); const view = await response.json();
  expect(view.currentDeviceId).toBe(member.deviceId);
  const rows = view.runtimes.find((row: { id: string }) => row.id === 'fake').accounts;
  expect(rows.find((row: { view: { account: { id: string } } }) => row.view.account.id === 'shared_ready').availability).toMatchObject({ eligible: true, label: 'Ready' });
  const local = rows.find((row: { view: { account: { id: string } } }) => row.view.account.id === 'acc_fixture');
  expect(local.availability).toMatchObject({ eligible: false, label: 'Needs login' });
  expect(local.devices.find((row: { id: string }) => row.id === member.deviceId)).toMatchObject({ here: true, available: true, loginLabel: 'Log in here' });
});

test('account read model deduplicates offered models and gives empty runtimes an explicit fallback', async () => {
  f = await projectFixture(); const store = seed('other_offer');
  const offered = [{ id: 'shared-offer', label: 'Shared offer', efforts: ['high' as const] }];
  store.recordModels('acc_fixture', offered); store.recordModels('other_offer', offered);
  const response = await f.request('/api/accounts/view'); expect(response.status).toBe(200); const view = await response.json();
  const row = view.runtimes.find((runtime: { id: string }) => runtime.id === 'fake');
  expect(row.models).toEqual([{ schema: 'account-model-chip-v1', id: 'shared-offer', label: 'Shared offer', title: 'shared-offer · high' }]);
  expect(row.emptyModelsText).toBeNull();
  expect(f.fake.runs).toHaveLength(0);
});
