import { AccountActionSchema, AccountLoginActionSchema, AccountWriteActionSchema } from './account-action-schemas.js';
import type { AccountView } from './client-schemas.js';
export function accountLoginAction(accountId: string, deviceId: string, label = 'Log in') {
  return AccountLoginActionSchema.parse({ schema: 'account-action-v1', id: 'login', label, style: 'secondary small', kind: 'login', path: `/api/accounts/${accountId}/login?deviceId=${encodeURIComponent(deviceId)}`, method: 'POST', expected: { accountId, deviceId } });
}
export function accountEnableAction(view: AccountView, enabled = !view.account.enabled) {
  const { account } = view;
  return AccountWriteActionSchema.parse({ schema: 'account-action-v1', id: 'toggle', label: enabled ? 'Enable account' : 'Disable', style: 'text-button', kind: 'write', path: `/hub/accounts/${account.id}`, method: 'PATCH', body: { schema: 'update-account-v1', revision: view.revision, label: account.label, enabled, ceilingPct: account.ceilingPct, ...(account.paidUse ? { paidUse: account.paidUse } : {}) } });
}
export function accountActions(view: AccountView, deviceId: string) {
  const { account } = view;
  const edit = AccountActionSchema.parse({ schema: 'account-action-v1', id: 'edit', label: 'Edit', style: 'text-button', kind: 'editor', mode: 'edit' });
  const replace = AccountActionSchema.parse({ schema: 'account-action-v1', id: 'replace-key', label: 'Replace key', style: 'text-button', kind: 'editor', mode: 'replace-key' });
  const login = accountLoginAction(account.id, deviceId);
  const toggle = { ...accountEnableAction(view), label: account.enabled ? 'Disable' : 'Enable' };
  return { actions: [ ...(account.kind === 'subscription' && account.credential !== 'per-device' ? [login] : []), AccountActionSchema.parse({ schema: 'account-action-v1', id: 'check', label: 'Check now', style: 'secondary small', kind: 'write', path: `/api/accounts/${account.id}/check`, method: 'POST', body: { schema: 'empty-request-v1' } }), edit, ...(account.kind === 'api-key' ? [replace] : []), toggle ], deepLinkAction: account.kind === 'api-key' ? replace : account.kind === 'endpoint' ? edit : login };
}
