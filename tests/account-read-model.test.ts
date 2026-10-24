import { afterEach, expect, test } from 'vitest';
import { AccountBudgetUsageViewSchema, AccountSchema, AccountStatusSchema, AccountViewSchema, type AccountStatus } from '../packages/core/dist/index.js';
import { accountBudgetView } from '../packages/accounts/dist/index.js';
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

const budgetNow = Date.parse('2026-10-24T09:00:00.000Z');
const budgetAt = (offset: number) => new Date(budgetNow + offset).toISOString();
function budgetStatus(deviceId: string, usage: AccountStatus['usage'], accountId = 'budget'): AccountStatus {
  return AccountStatusSchema.parse({ schema: 'account-status-v2', accountId, deviceId, auth: 'ready', observedAt: budgetAt(0), usage });
}
function budget(statuses: AccountStatus[]) {
  return AccountViewSchema.parse({ schema: 'account-view-v1', revision: 1, account: { schema: 'account-v2', id: 'budget', runtime: 'fake', label: 'main', kind: 'subscription', enabled: true, credential: 'per-device', ceilingPct: 80 }, statuses });
}

test('budget windows use one latest observation and never backfill from another device', () => {
  const old = budgetStatus('device_old', { source: 'stream', observedAt: budgetAt(-2000), weeklyPct: 49, fiveHourPct: 12 });
  const latest = budgetStatus('device_new', { source: 'probe', observedAt: budgetAt(-1000), fiveHourPct: 71 });
  const input = budget([old, latest]), before = structuredClone(input);
  expect(accountBudgetView(input, id => `Name ${id}`, budgetNow)).toEqual({ label: 'main', budgetPercent: 80, usedPercent: null,
    usage: { schema: 'account-budget-usage-v1', accountId: 'budget', deviceId: 'device_new', deviceName: 'Name device_new', source: 'probe', observedAt: budgetAt(-1000),
      weekly: { usedPercent: null, state: 'unknown', resetsAt: null }, fiveHour: { usedPercent: 71, state: 'reported', resetsAt: null } } });
  expect(input).toEqual(before);
  expect(accountBudgetView(budget([latest, old]), id => `Name ${id}`, budgetNow)).toEqual(accountBudgetView(input, id => `Name ${id}`, budgetNow));
});

test('budget window reset, zero and unknown-source readings remain distinct', () => {
  const reported = budgetStatus('device_a', { source: 'stream', observedAt: budgetAt(-1000), weeklyPct: 25, fiveHourPct: 0, weeklyResetsAt: budgetAt(0), fiveHourResetsAt: budgetAt(1000) });
  const view = accountBudgetView(budget([reported]), id => id, budgetNow);
  expect(view.usedPercent).toBeNull();
  expect(view.usage).toMatchObject({ weekly: { state: 'reset', usedPercent: null, resetsAt: budgetAt(0) }, fiveHour: { state: 'reported', usedPercent: 0, resetsAt: budgetAt(1000) } });
  const unknown = budgetStatus('device_b', { source: 'unknown', observedAt: budgetAt(0), weeklyPct: 99, fiveHourPct: 99 });
  expect(accountBudgetView(budget([reported, unknown]), id => id, budgetNow)).toMatchObject({ usedPercent: null,
    usage: { deviceId: 'device_b', source: 'unknown', weekly: { state: 'unknown', usedPercent: null }, fiveHour: { state: 'unknown', usedPercent: null } } });
});

test('budget attribution ignores foreign accounts and breaks observation ties consistently', () => {
  const a = budgetStatus('device_a', { source: 'stream', observedAt: budgetAt(0), weeklyPct: 1 });
  const b = budgetStatus('device_b', { source: 'probe', observedAt: budgetAt(0), weeklyPct: 77 });
  const foreign = budgetStatus('device_other', { source: 'probe', observedAt: budgetAt(1000), weeklyPct: 100 }, 'other_account');
  const first = accountBudgetView(budget([foreign, b, a]), id => id, budgetNow);
  expect(first).toMatchObject({ usedPercent: 1, usage: { accountId: 'budget', deviceId: 'device_a', source: 'stream' } });
  expect(accountBudgetView(budget([a, b, foreign]), id => id, budgetNow)).toEqual(first);
  expect(AccountBudgetUsageViewSchema.safeParse({ ...first.usage, extra: true }).success).toBe(false);
});

test('missing budget observations remain unknown without inventing a device or timestamp', () => {
  expect(accountBudgetView(budget([]), id => id, budgetNow)).toMatchObject({ usedPercent: null,
    usage: { accountId: 'budget', deviceId: null, deviceName: null, source: 'unknown', observedAt: null, weekly: { usedPercent: null, state: 'unknown' }, fiveHour: { usedPercent: null, state: 'unknown' } } });
});

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
