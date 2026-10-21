import { accountActions, accountLoginAction, ACCOUNT_PAID_LABELS } from '@jevellan/core';
import type { z } from 'zod';
import { AccountsSettingsViewSchema, AccountAvailabilitySchema, ACCOUNT_VIEW_REFRESH_MS, currentUsage, IdSchema, type AccountView, type Configuration, type DeviceRosterSchema, type OfferedModelsSchema } from '@jevellan/core';
import { rankAccounts, type RankedAccount } from './eligibility.js';

/** Eligibility comes from the same ranked cohort used for placement; copy only explains that result. */
export function accountAvailability(ranked: RankedAccount, runtimeEnabled: boolean, now = Date.now()) {
  const { account, status, reason } = ranked;
  const result = (label: string, tone: z.infer<typeof AccountAvailabilitySchema>['tone']) => AccountAvailabilitySchema.parse({ schema: 'account-availability-v1', label, tone, eligible: runtimeEnabled && ranked.eligible, reason: runtimeEnabled ? reason : 'runtime-disabled' });
  if (!account.enabled) return result('Disabled', 'disabled');
  if (!runtimeEnabled) return result('Runtime disabled', 'disabled');
  if (account.kind === 'endpoint' && status?.auth !== 'checking' && status?.lastError) return result(status.auth === 'needs-login' ? 'Key refused' : status.lastError, status.auth === 'needs-login' ? 'needs-login' : 'unknown');
  if (status?.auth !== 'ready') {
    const labels = { 'needs-login': 'Needs login', missing: 'Needs login', expired: 'Expired', revoked: 'Revoked', checking: 'Checking', unknown: 'Unknown' };
    return result(status ? labels[status.auth] : 'Needs login', status?.auth ?? 'missing');
  }
  if (reason === 'cooling') return result('Cooling down', 'limited');
  if (reason === 'usage-ceiling') return result(Object.values(currentUsage(status.usage, now)).some(value => value >= 100) ? 'Quota exhausted' : 'Usage ceiling reached', 'limited');
  if (reason === 'paid-not-allowed') return result('Paid use not allowed', 'limited');
  if (!ranked.eligible) return result(reason === 'model-not-served' ? 'Model not served' : 'Unavailable', 'unknown');
  if (Object.values(status.modelCooling ?? {}).some(until => Date.parse(until) > now)) return result('Some models cooling', 'limited');
  if (status.lastError) return result('Signed in · check failed', 'unknown');
  return result('Ready', 'ready');
}
export function accountsSettingsView(input: { accounts: AccountView[]; offered: z.infer<typeof OfferedModelsSchema>[]; runtimeIds: string[]; configuration: Configuration; roster: z.infer<typeof DeviceRosterSchema>; deviceId: string; now?: number }) {
  const now = input.now ?? Date.now(), deviceId = IdSchema.parse(input.deviceId), accounts = input.accounts.map(view => view.account), statuses = input.accounts.flatMap(view => view.statuses);
  const rankedFor = (runtime: string, device: string) => new Map(rankAccounts({ accounts, statuses, runtime, deviceId: device, now }).map(row => [row.account.id, row]));
  return AccountsSettingsViewSchema.parse({ schema: 'accounts-settings-view-v1', currentDeviceId: deviceId, at: new Date(now).toISOString(), refreshMs: ACCOUNT_VIEW_REFRESH_MS,
    runtimes: input.runtimeIds.map(runtime => {
      const enabled = input.configuration['x-jevellan'].runtimes[runtime]?.enabled === true, ranked = rankedFor(runtime, deviceId);
      const seen = new Set<string>(), models = input.offered.filter(row => row.runtime === runtime).flatMap(row => row.models).filter(model => { if (seen.has(model.id)) return false; seen.add(model.id); return true; }).map(model => ({ schema: 'account-model-chip-v1', id: model.id, label: model.label, title: `${model.id} · ${model.efforts.join(', ')}` }));
      return { schema: 'account-runtime-view-v1', id: runtime, models, emptyModelsText: models.length ? null : 'Models appear after an account is checked.',
        accounts: input.accounts.filter(view => view.account.runtime === runtime).map(view => {
          const row = ranked.get(view.account.id)!, { account, status } = row, availability = accountAvailability(row, enabled, now), usage = currentUsage(status?.usage, now);
          const notices: { schema: 'account-notice-v1'; id: string; text: string; at: string | null; suffix: string }[] = [];
          const notice = (id: string, text: string, at: string | null = null, suffix = '') => { notices.push({ schema: 'account-notice-v1', id, text, at, suffix }); };
          if (row.reason === 'usage-ceiling') notice('ceiling', `Usage reached this account’s ${account.ceilingPct}% ceiling. Jevellan will use another eligible account.`);
          if (status?.coolingUntil && Date.parse(status.coolingUntil) > now) notice('cooling', 'Cooling until ', status.coolingUntil);
          for (const [model, until] of Object.entries(status?.modelCooling ?? {})) if (Date.parse(until) > now) notice(`model:${model}`, `${input.configuration['x-jevellan'].menu.find(entry => entry.runtime === runtime && entry.model === model)?.label ?? model} reached its limit on this account. Cooling until `, until, '; other models can still use it.');
          if (status?.lastError && account.kind !== 'endpoint') notice('last-error', status.lastError);
          return { schema: 'account-settings-row-v1', view, ...accountActions(view, deviceId), availability, kindLabel: account.kind === 'endpoint' ? 'Compatible endpoint' : account.kind === 'api-key' ? 'API key' : 'Subscription', secretLine: view.secret ? `Saved · ••••${view.secret.lastFour}` : null, paidUseLine: account.paidUse ? ACCOUNT_PAID_LABELS[account.paidUse] : null,
            usage: account.kind === 'endpoint' ? [] : (['fiveHour', 'weekly'] as const).map(key => { const value = key === 'fiveHour' ? usage.fiveHourPct : usage.weeklyPct; return { schema: 'account-usage-window-v1', key, label: key === 'fiveHour' ? 'Five hours' : 'Week', valueLabel: value === undefined ? 'Unknown' : `${value}%`, resetLabel: 'Resets', value: value ?? null, resetAt: value === undefined ? null : (key === 'fiveHour' ? status?.usage?.fiveHourResetsAt : status?.usage?.weeklyResetsAt) ?? null }; }), usageCheckedAt: status?.usage?.observedAt ?? null, usageCheckedLabel: 'Usage checked', notices,
            devices: account.credential !== 'per-device' ? [] : input.roster.devices.filter(device => !device.revoked).map(device => {
              const here = device.device.id === deviceId, available = here || device.status !== 'offline', ranked = rankedFor(runtime, device.device.id).get(account.id)!;
              return { schema: 'account-device-row-v1', id: device.device.id, name: device.device.name, here, available, availability: available ? accountAvailability(ranked, enabled, now) : { schema: 'account-availability-v1', label: 'Offline', tone: 'offline', eligible: false, reason: 'offline' }, loginLabel: here ? 'Log in here' : `Log in on ${device.device.name}`, loginPlan: accountLoginAction(account.id, device.device.id, here ? 'Log in here' : `Log in on ${device.device.name}`) };
            }), deviceNote: account.credential === 'per-device' ? `${runtime === 'codex' ? 'Codex' : 'Account'} sign-ins are kept per device for now.` : null };
        }) };
    }) });
}
