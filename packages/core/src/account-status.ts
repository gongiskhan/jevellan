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
