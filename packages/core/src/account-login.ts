import { AccountLoginPresentationSchema } from './account-login-schemas.js';
import { accountEnableAction, accountLoginAction } from './account-actions.js';
import type { AccountView, LoginViewSchema } from './client-schemas.js';
import type { z } from 'zod';
/** Presentation only. Provider admission, credentials, receipts and process ownership stay with AccountService. */
export function accountLoginPresentation(view: z.infer<typeof LoginViewSchema>, input: { account: AccountView; availabilityLabel: string | null; requesterDeviceId: string; deviceName: string }) {
  const path = `/api/logins/${view.id}?deviceId=${encodeURIComponent(view.deviceId)}`, pending = view.state === 'pending', active = pending || view.state === 'checking';
  return AccountLoginPresentationSchema.parse({ schema: 'account-login-presentation-v1', title: `Log in · ${input.account.account.label}`, deviceLine: view.deviceId === input.requesterDeviceId ? null : `On ${input.deviceName}`,
    poll: { enabled: active, path, intervalMs: 1000, errorDelayMs: 2000 },
    pending: { visible: pending, openLabel: 'Open sign-in page ↗', preparingText: 'Preparing the sign-in link…', waitingText: pending && !view.acceptsCode && !view.userCode && view.url ? 'Code sent. Waiting for sign-in to finish…' : null },
    verificationLabel: 'Verification code', checkingText: view.state === 'checking' ? 'Checking the account…' : null,
    code: { visible: pending && view.acceptsCode, label: input.account.account.runtime === 'codex' ? 'Callback address' : 'Authorization code', submitLabel: 'Continue', plan: { path, method: 'POST' } },
    close: { cancel: active, plan: { path, method: 'DELETE' } },
    restart: { visible: view.state === 'failed' || view.state === 'cancelled' || (pending && !view.acceptsCode && !view.userCode), label: 'Start again', plan: accountLoginAction(view.accountId, view.deviceId) },
    success: view.state === 'done' ? { identityLine: input.account.account.identity?.email ? `Signed in as ${input.account.account.identity.email}` : 'Signed in successfully.', availabilityLine: input.availabilityLabel ? `${input.availabilityLabel}.` : null, needsEnable: !input.account.account.enabled, enableText: 'Sign-in saved your credentials. Enable this account to let Jevellan use it.', enablePlan: accountEnableAction(input.account, true) } : null,
  });
}
