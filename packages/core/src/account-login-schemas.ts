import { z } from 'zod';
import { AccountLoginActionSchema, AccountWriteActionSchema } from './account-action-schemas.js';
const operation = (method: 'POST' | 'DELETE') => z.strictObject({ path: z.string(), method: z.literal(method) });
export const AccountLoginPresentationSchema = z.strictObject({
  schema: z.literal('account-login-presentation-v1'), title: z.string(), deviceLine: z.string().nullable(),
  poll: z.strictObject({ enabled: z.boolean(), path: z.string(), intervalMs: z.literal(1000), errorDelayMs: z.literal(2000) }),
  pending: z.strictObject({ visible: z.boolean(), openLabel: z.string(), preparingText: z.string(), waitingText: z.string().nullable() }),
  verificationLabel: z.string(), checkingText: z.string().nullable(),
  code: z.strictObject({ visible: z.boolean(), label: z.string(), submitLabel: z.string(), plan: operation('POST') }),
  close: z.strictObject({ cancel: z.boolean(), plan: operation('DELETE') }),
  restart: z.strictObject({ visible: z.boolean(), label: z.string(), plan: AccountLoginActionSchema }),
  success: z.strictObject({ identityLine: z.string(), availabilityLine: z.string().nullable(), needsEnable: z.boolean(), enableText: z.string(), enablePlan: AccountWriteActionSchema }).nullable(),
});
export type AccountLoginPresentation = z.infer<typeof AccountLoginPresentationSchema>;
