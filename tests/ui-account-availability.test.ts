import { expect, test } from 'vitest';
import { AccountSchema, AccountStatusSchema, type AccountStatus } from '../packages/core/dist/index.js';
import { rankAccounts } from '../packages/accounts/dist/index.js';
import { accountAvailability } from '../apps/web/src/account-availability.js';

const now = Date.parse('2026-10-01T16:35:00Z');
const account = AccountSchema.parse({ schema: 'account-v1', id: 'fixture', label: 'Fixture', runtime: 'claude', kind: 'subscription', enabled: true, credential: 'shared', ceilingPct: 90 });
const status = (changes: Partial<AccountStatus> = {}) => AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: account.id, deviceId: 'here', auth: 'ready', observedAt: new Date(now).toISOString(), ...changes });
const usage = (fiveHourPct: number, weeklyPct = 72) => ({ source: 'probe' as const, observedAt: new Date(now).toISOString(), fiveHourPct, weeklyPct });

test.each([
  [status({ coolingUntil: '2026-10-01T17:00:00Z', usage: usage(100) }), 'Cooling down'],
  [status({ usage: usage(100) }), 'Quota exhausted'],
  [status({ usage: usage(31, 100) }), 'Quota exhausted'],
  [status({ usage: usage(90) }), 'Usage ceiling reached'],
  [status({ usage: usage(31, 90) }), 'Usage ceiling reached'],
])('an authenticated but unavailable account is never shown Ready: %s', (value, label) => {
  expect(rankAccounts({ accounts: [account], statuses: [value], runtime: 'claude', deviceId: 'here', now })[0]?.eligible).toBe(false);
  expect(accountAvailability(account, value, true, now)).toEqual({ label, tone: 'limited' });
});

test('sign-in does not hide the separate account or runtime enable switches', () => {
  expect(accountAvailability({ ...account, enabled: false }, status(), true, now).label).toBe('Disabled');
  expect(accountAvailability(account, status(), false, now).label).toBe('Runtime disabled');
  expect(accountAvailability(account, status({ usage: usage(31) }), true, now).label).toBe('Ready');
});

test('cooldown expiry does not erase still-exhausted usage', () => {
  const expired = { coolingUntil: '2026-10-01T16:00:00Z' };
  expect(accountAvailability(account, status({ ...expired, usage: usage(100) }), true, now).label).toBe('Quota exhausted');
  expect(accountAvailability(account, status({ ...expired, usage: usage(10) }), true, now).label).toBe('Ready');
});

test('a model-specific limit is distinguished from the whole account cooling down', () => {
  expect(accountAvailability(account, status({ modelCooling: { opus: '2026-10-01T17:00:00Z' } }), true, now).label).toBe('Some models cooling');
  expect(accountAvailability(account, status({ modelCooling: { opus: '2026-10-01T16:00:00Z' } }), true, now).label).toBe('Ready');
});

test('missing credentials and failed checks cannot advertise a fresh Ready state', () => {
  expect(accountAvailability(account, undefined, true, now).label).toBe('Needs login');
  expect(accountAvailability(account, status({ auth: 'missing' }), true, now).label).toBe('Needs login');
  expect(accountAvailability(account, status({ auth: 'expired' }), true, now).label).toBe('Expired');
  expect(accountAvailability(account, status({ lastError: 'Provider unavailable' }), true, now).label).toBe('Signed in · check failed');
});
