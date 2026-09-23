import { expect, test } from 'vitest';
import { AccountSchema, AccountStatusSchema, type Account, type AccountStatus } from '../packages/core/dist/index.js';
import { applyAccountError, rankAccounts } from '../packages/accounts/dist/index.js';

const now = Date.parse('2026-09-24T12:00:00Z');
function account(id: string, over: Partial<Account> = {}): Account {
  return AccountSchema.parse({ schema: 'account-v1', id, runtime: 'codex', label: id, kind: 'subscription', enabled: true, credential: 'per-device', ...over });
}
function status(id: string, over: Partial<AccountStatus> = {}): AccountStatus {
  return AccountStatusSchema.parse({ schema: 'account-status-v1', accountId: id, deviceId: 'here', auth: 'ready', observedAt: new Date(now).toISOString(), ...over });
}
const usage = (fiveHourPct: number, weeklyPct: number) => ({ fiveHourPct, weeklyPct, source: 'probe' as const, observedAt: new Date(now).toISOString() });
function rank(accounts: Account[], statuses: AccountStatus[]) { return rankAccounts({ accounts, statuses, runtime: 'codex', deviceId: 'here', now }); }

test('unknown usage remains eligible and known usage ranks ahead of it', () => {
  expect(rank([account('unknown'), account('known')], [status('unknown'), status('known', { usage: usage(70, 40) })]).map((entry) => [entry.account.id, entry.eligible])).toEqual([['known', true], ['unknown', true]]);
});
test('ranking uses the larger window, then weekly usage and label', () => {
  const entries = rank(['high', 'tieB', 'tieA', 'low'].map((id) => account(id)), [status('high', { usage: usage(5, 85) }), status('tieB', { usage: usage(30, 30) }), status('tieA', { usage: usage(30, 20) }), status('low', { usage: usage(10, 5) })]);
  expect(entries.map((entry) => entry.account.id)).toEqual(['low', 'tieA', 'tieB', 'high']);
});
test('an API key requires an explicit paid-use choice', () => {
  expect(() => account('api', { kind: 'api-key', credential: 'shared' })).toThrow('Choose when');
});
test('fallback payment depends only on eligible subscriptions of the same runtime', () => {
  const api = account('api', { kind: 'api-key', credential: 'shared', paidUse: 'when-subscriptions-run-out' });
  expect(rank([api, account('sub')], [status('api'), status('sub')]).find((entry) => entry.account.id === 'api')?.reason).toBe('paid-not-allowed');
  expect(rank([api, account('sub')], [status('api'), status('sub', { usage: usage(90, 1) })]).find((entry) => entry.account.id === 'api')?.eligible).toBe(true);
  expect(rank([api, account('other', { runtime: 'claude', credential: 'shared' })], [status('api'), status('other')]).find((entry) => entry.account.id === 'api')?.eligible).toBe(true);
});
test('never-paid keys remain excluded, and subscriptions rank before always-paid keys', () => {
  const accounts = [account('never', { kind: 'api-key', credential: 'shared', paidUse: 'never' }), account('always', { kind: 'api-key', credential: 'shared', paidUse: 'always' }), account('sub')];
  const ranked = rank(accounts, accounts.map((entry) => status(entry.id)));
  expect(ranked.map((entry) => [entry.account.id, entry.eligible])).toEqual([['sub', true], ['always', true], ['never', false]]);
});
test('per-device credentials never borrow readiness from another device', () => {
  expect(rank([account('local')], [status('local', { deviceId: 'elsewhere' })])[0]?.reason).toBe('needs-login');
  expect(rank([account('shared', { kind: 'api-key', credential: 'shared', paidUse: 'always' })], [status('shared', { deviceId: 'elsewhere' })])[0]?.eligible).toBe(true);
});
test.each([
  [{ enabled: false }, {}, 'disabled'], [{}, { auth: 'expired' }, 'expired'],
  [{}, { coolingUntil: new Date(now + 1000).toISOString() }, 'cooling'], [{}, { usage: usage(1, 90) }, 'usage-ceiling'],
] as const)('excludes accounts for resources and limits', (accountOverride, statusOverride, reason) => {
  expect(rank([account('test', accountOverride)], [status('test', statusOverride)])[0]?.reason).toBe(reason);
});
test('only auth and rate-limit failures change readiness; unknown reset cools for 30 minutes', () => {
  const current = status('test');
  expect(applyAccountError(current, 'other', now)).toBe(current);
  expect(applyAccountError(current, 'auth', now).auth).toBe('needs-login');
  expect(applyAccountError(current, 'rate-limit', now).coolingUntil).toBe(new Date(now + 30 * 60_000).toISOString());
  const reset = new Date(now + 60_000).toISOString();
  expect(applyAccountError(status('test', { usage: { ...usage(100, 1), fiveHourResetsAt: reset } }), 'rate-limit', now).coolingUntil).toBe(reset);
  expect(applyAccountError(status('test', { usage: { ...usage(100, 1), fiveHourResetsAt: reset, weeklyResetsAt: new Date(now + 7 * 24 * 60 * 60_000).toISOString() } }), 'rate-limit', now).coolingUntil).toBe(reset);
});
