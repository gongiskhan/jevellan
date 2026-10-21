import type { Account, AccountStatus } from './schemas.js';

/** Shared vault credentials use real observations across devices; an unprobed member is not a revoked login. */
export function effectiveAccountStatus(account: Account, statuses: readonly AccountStatus[], deviceId: string): AccountStatus | undefined {
  // A local endpoint may be reachable on one member and unavailable on another. Credential rotation resets these observations to checking.
  if (account.kind === 'endpoint') {
    const local = statuses.filter(status => status.accountId === account.id && status.deviceId === deviceId).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (local && local.auth !== 'missing' && local.auth !== 'checking') return local;
  }
  return statuses.filter(status => status.accountId === account.id && (account.credential === 'shared' ? status.auth !== 'missing' : status.deviceId === deviceId))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
}

/**
 * The usage windows still current at `now`, as a percentage each: a reading taken before its window reset says nothing about the account
 * any more, so it is unknown until the next probe instead of blocking work (a five-hour reading at the ceiling would otherwise last until
 * something probed the account again, and nothing places work on an account at its ceiling).
 */
export function currentUsage(usage: AccountStatus['usage'] | undefined, now = Date.now()): { fiveHourPct?: number; weeklyPct?: number } {
  const current = (pct: number | undefined, reset: string | undefined) => pct !== undefined && (!reset || Date.parse(reset) > now) ? pct : undefined;
  const fiveHourPct = current(usage?.fiveHourPct, usage?.fiveHourResetsAt); const weeklyPct = current(usage?.weeklyPct, usage?.weeklyResetsAt);
  return { ...(fiveHourPct === undefined ? {} : { fiveHourPct }), ...(weeklyPct === undefined ? {} : { weeklyPct }) };
}
