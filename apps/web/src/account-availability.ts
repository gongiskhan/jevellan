import type { Account, AccountStatus } from '@jevellan/core/client';

/** Authentication and availability are separate: valid credentials may still be unable to run. */
export function accountAvailability(account: Account, status: AccountStatus | undefined, runtimeEnabled: boolean, now = Date.now()): { label: string; tone: string } {
  if (!account.enabled) return { label: 'Disabled', tone: 'disabled' };
  if (!runtimeEnabled) return { label: 'Runtime disabled', tone: 'disabled' };
  if (status?.auth !== 'ready') {
    const labels = { 'needs-login': 'Needs login', missing: 'Needs login', expired: 'Expired', revoked: 'Revoked', checking: 'Checking', unknown: 'Unknown' };
    return { label: status ? labels[status.auth] : 'Needs login', tone: status?.auth ?? 'missing' };
  }
  if (status.coolingUntil && Date.parse(status.coolingUntil) > now) return { label: 'Cooling down', tone: 'limited' };
  const usage = [status.usage?.fiveHourPct, status.usage?.weeklyPct].filter((value): value is number => value !== undefined);
  if (usage.some(value => value >= 100)) return { label: 'Quota exhausted', tone: 'limited' };
  if (usage.some(value => value >= account.ceilingPct)) return { label: 'Usage ceiling reached', tone: 'limited' };
  if (Object.values(status.modelCooling ?? {}).some(until => Date.parse(until) > now)) return { label: 'Some models cooling', tone: 'limited' };
  if (status.lastError) return { label: 'Signed in · check failed', tone: 'unknown' };
  return { label: 'Ready', tone: 'ready' };
}
