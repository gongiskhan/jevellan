import { AccountSchema, AccountStatusSchema, type Account, type AccountStatus, type ExclusionReason } from '@jevellan/core';

export type RankedAccount = { account: Account; status?: AccountStatus; eligible: boolean; reason: ExclusionReason | 'eligible'; knownUsage: boolean; effectivePct: number; weeklyPct: number };
/** model: the runtime's model id; a limit on that model on an account excludes the account for it as 'cooling'. */
export function rankAccounts(input: { accounts: Account[]; statuses: AccountStatus[]; runtime: string; model?: string; deviceId: string; now?: number }): RankedAccount[] {
  const now = input.now ?? Date.now();
  const statuses = input.statuses.map((status) => AccountStatusSchema.parse(status));
  const base = input.accounts.map((raw): RankedAccount => {
    const account = AccountSchema.parse(raw);
    const status = statuses.filter((value) => value.accountId === account.id && (account.credential === 'shared' || value.deviceId === input.deviceId)).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    const windows = [status?.usage?.fiveHourPct, status?.usage?.weeklyPct].filter((value): value is number => value !== undefined);
    let reason: RankedAccount['reason'] = 'eligible';
    if (account.runtime !== input.runtime || account.credential === 'hub-refreshed') reason = 'unsupported';
    else if (!account.enabled) reason = 'disabled';
    else if (status?.auth !== 'ready') reason = status?.auth === 'expired' ? 'expired' : 'needs-login';
    else if (status.coolingUntil && Date.parse(status.coolingUntil) > now) reason = 'cooling';
    else if (input.model && status.modelCooling?.[input.model] && Date.parse(status.modelCooling[input.model]!) > now) reason = 'cooling';
    else if (windows.some((value) => value >= account.ceilingPct)) reason = 'usage-ceiling';
    return { account, ...(status ? { status } : {}), eligible: reason === 'eligible', reason, knownUsage: windows.length > 0, effectivePct: windows.length ? Math.max(...windows) : 0, weeklyPct: status?.usage?.weeklyPct ?? 0 };
  });
  const subscriptionReady = base.some((entry) => entry.eligible && entry.account.kind === 'subscription');
  for (const entry of base) if (entry.eligible && entry.account.kind === 'api-key') {
    if (entry.account.paidUse === 'never' || (entry.account.paidUse === 'when-subscriptions-run-out' && subscriptionReady)) {
      entry.eligible = false; entry.reason = 'paid-not-allowed';
    }
  }
  return base.sort((a, b) => Number(b.eligible) - Number(a.eligible) ||
    Number(a.account.kind === 'api-key') - Number(b.account.kind === 'api-key') ||
    Number(b.knownUsage) - Number(a.knownUsage) || a.effectivePct - b.effectivePct || a.weeklyPct - b.weeklyPct ||
    a.account.label.localeCompare(b.account.label) || a.account.id.localeCompare(b.account.id));
}

export function applyAccountError(status: AccountStatus, kind: 'rate-limit' | 'auth' | 'other', now = Date.now(), limit: { model?: string; resetsAt?: string } = {}): AccountStatus {
  AccountStatusSchema.parse(status);
  if (kind === 'other') return status;
  if (kind === 'auth') return AccountStatusSchema.parse({ ...status, auth: 'needs-login', observedAt: new Date(now).toISOString() });
  if (limit.model) {
    // One model's limit cools only that model on this account; expired entries are dropped.
    const reset = limit.resetsAt && Date.parse(limit.resetsAt) > now ? Date.parse(limit.resetsAt) : now + 30 * 60_000;
    const cooling = Object.fromEntries(Object.entries(status.modelCooling ?? {}).filter(([, until]) => Date.parse(until) > now));
    return AccountStatusSchema.parse({ ...status, modelCooling: { ...cooling, [limit.model]: new Date(reset).toISOString() }, observedAt: new Date(now).toISOString() });
  }
  const windows = [{ pct: status.usage?.fiveHourPct, reset: status.usage?.fiveHourResetsAt }, { pct: status.usage?.weeklyPct, reset: status.usage?.weeklyResetsAt }];
  const exhausted = windows.filter((window) => window.pct !== undefined && window.pct >= 100);
  const resets = (exhausted.length ? exhausted : windows).flatMap((window) => window.reset && Date.parse(window.reset) > now ? [Date.parse(window.reset)] : []);
  const until = resets.length ? (exhausted.length ? Math.max(...resets) : Math.min(...resets)) : now + 30 * 60_000;
  return AccountStatusSchema.parse({ ...status, coolingUntil: new Date(until).toISOString(), observedAt: new Date(now).toISOString() });
}
