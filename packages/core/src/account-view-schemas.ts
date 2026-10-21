import { AccountActionSchema, AccountLoginActionSchema } from './account-action-schemas.js';
import { z } from 'zod';
import { AccountViewSchema } from './client-schemas.js';
import { ExclusionReasonSchema, IdSchema, TimestampSchema } from './schemas.js';
export const ACCOUNT_VIEW_REFRESH_MS = 30_000;
export const AccountAvailabilitySchema = z.strictObject({ schema: z.literal('account-availability-v1'), label: z.string(), tone: z.enum(['disabled', 'needs-login', 'missing', 'expired', 'revoked', 'checking', 'unknown', 'limited', 'ready', 'offline']), eligible: z.boolean(), reason: ExclusionReasonSchema.or(z.enum(['eligible', 'runtime-disabled', 'offline'])) });
export const AccountSettingsRowSchema = z.strictObject({ schema: z.literal('account-settings-row-v1'), view: AccountViewSchema, actions: z.array(AccountActionSchema).optional(), deepLinkAction: AccountActionSchema.optional(), availability: AccountAvailabilitySchema, kindLabel: z.string(), secretLine: z.string().nullable(), paidUseLine: z.string().nullable(),
  usage: z.array(z.strictObject({ schema: z.literal('account-usage-window-v1'), key: z.enum(['fiveHour', 'weekly']), label: z.string(), valueLabel: z.string(), resetLabel: z.string(), value: z.number().min(0).max(100).nullable(), resetAt: TimestampSchema.nullable() })), usageCheckedAt: TimestampSchema.nullable(), usageCheckedLabel: z.string(),
  notices: z.array(z.strictObject({ schema: z.literal('account-notice-v1'), id: z.string(), text: z.string(), at: TimestampSchema.nullable(), suffix: z.string() })),
  devices: z.array(z.strictObject({ schema: z.literal('account-device-row-v1'), id: IdSchema, name: z.string(), here: z.boolean(), available: z.boolean(), availability: AccountAvailabilitySchema, loginLabel: z.string(), loginPlan: AccountLoginActionSchema.optional() })), deviceNote: z.string().nullable(),
});
export const AccountsSettingsViewSchema = z.strictObject({ schema: z.literal('accounts-settings-view-v1'), currentDeviceId: IdSchema, at: TimestampSchema, refreshMs: z.literal(ACCOUNT_VIEW_REFRESH_MS),
  runtimes: z.array(z.strictObject({ schema: z.literal('account-runtime-view-v1'), id: IdSchema,
    models: z.array(z.strictObject({ schema: z.literal('account-model-chip-v1'), id: z.string(), label: z.string(), title: z.string() })), emptyModelsText: z.string().nullable(), accounts: z.array(AccountSettingsRowSchema) })),
});
export type AccountSettingsRow = z.infer<typeof AccountSettingsRowSchema>;
export type AccountsSettingsView = z.infer<typeof AccountsSettingsViewSchema>;
