import { AccountSchema, AccountStatusSchema, effectiveAccountStatus, type Account, type AccountStatus, type ExclusionReason } from '@jevellan/core';

export type RankedAccount = { account: Account; status?: AccountStatus; eligible: boolean; reason: ExclusionReason | 'eligible'; knownUsage: boolean; effectivePct: number; weeklyPct: number };
/** model: the runtime's model id; a limit on that model on an account excludes the account for it as 'cooling'. */
export function rankAccounts(input: { accounts: Account[]; statuses: AccountStatus[]; runtime: string; model?: string; deviceId: string; now?: number }): RankedAccount[] {
  const now = input.now ?? Date.now();
  const statuses = input.statuses.map((status) => AccountStatusSchema.parse(status));
  const endpointModels = new Set(input.accounts.flatMap(account => account.kind === 'endpoint' ? account.endpoint!.models.map(model => model.id) : []));
  const metered = (account: Account) => account.kind === 'api-key' || account.kind === 'endpoint' && account.endpoint?.billing === 'metered';
  const base = input.accounts.map((raw): RankedAccount => {
    const account = AccountSchema.parse(raw);
    // Shared credentials live in the hub vault. A member without a local observation gets a
    // synthetic `missing` row; its timestamp must not invalidate a checked shared credential.
    // Actual probe failures and credential-rotation `checking` rows still take precedence.
    const status = effectiveAccountStatus(account, statuses, input.deviceId);
    const windows = account.kind === 'endpoint' ? [] : [status?.usage?.fiveHourPct, status?.usage?.weeklyPct].filter((value): value is number => value !== undefined);
    let reason: RankedAccount['reason'] = 'eligible';
    if (account.runtime !== input.runtime || account.credential === 'hub-refreshed') reason = 'unsupported';
    else if (input.model && (account.kind === 'endpoint' ? !account.endpoint!.models.some(model => model.id === input.model) : endpointModels.has(input.model))) reason = 'model-not-served';
    else if (!account.enabled) reason = 'disabled';
    else if (account.kind === 'endpoint' && status?.auth === 'unknown') reason = 'unreachable';
    else if (status?.auth !== 'ready') reason = status?.auth === 'expired' ? 'expired' : 'needs-login';
    else if (status.coolingUntil && Date.parse(status.coolingUntil) > now) reason = 'cooling';
    else if (input.model && status.modelCooling?.[input.model] && Date.parse(status.modelCooling[input.model]!) > now) reason = 'cooling';
    else if (windows.some((value) => value >= account.ceilingPct)) reason = 'usage-ceiling';
    return { account, ...(status ? { status } : {}), eligible: reason === 'eligible', reason, knownUsage: windows.length > 0, effectivePct: windows.length ? Math.max(...windows) : 0, weeklyPct: account.kind === 'endpoint' ? 0 : status?.usage?.weeklyPct ?? 0 };
  });
  const subscriptionReady = base.some((entry) => entry.eligible && !metered(entry.account));
  for (const entry of base) if (entry.eligible && metered(entry.account)) {
    if (entry.account.paidUse === 'never' || (entry.account.paidUse === 'when-subscriptions-run-out' && subscriptionReady)) {
      entry.eligible = false; entry.reason = 'paid-not-allowed';
    }
  }
  return base.sort((a, b) => Number(b.eligible) - Number(a.eligible) ||
    Number(metered(a.account)) - Number(metered(b.account)) ||
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
  const providerReset = limit.resetsAt && Date.parse(limit.resetsAt) > now ? Date.parse(limit.resetsAt) : undefined;
  const until = providerReset !== undefined ? Math.max(providerReset, ...(exhausted.length ? resets : []))
    : resets.length ? (exhausted.length ? Math.max(...resets) : Math.min(...resets)) : now + 30 * 60_000;
  return AccountStatusSchema.parse({ ...status, coolingUntil: new Date(until).toISOString(), observedAt: new Date(now).toISOString() });
}
