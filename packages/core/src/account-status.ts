import type { Account, AccountStatus } from './schemas.js';

/** Shared vault credentials use real observations across devices; an unprobed member is not a revoked login. */
export function effectiveAccountStatus(account: Account, statuses: readonly AccountStatus[], deviceId: string): AccountStatus | undefined {
  return statuses.filter(status => status.accountId === account.id && (account.credential === 'shared' ? status.auth !== 'missing' : status.deviceId === deviceId))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
}
