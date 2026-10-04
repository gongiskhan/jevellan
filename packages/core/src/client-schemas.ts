import { z } from 'zod';
import { RiggingBundleSchema, RiggingBundleSummarySchema } from './rigging-bundle-schemas.js';
import { AccountSchema, AccountStatusSchema, AccountUsageSchema, AuthSchema, EffortSchema, IdSchema, TimestampSchema, RiggingItemSchema, ConfigurationSchema, ConfigRevisionSchema, DeviceSchema } from './schemas.js';

export const SecretSummarySchema = z.strictObject({ schema: z.literal('secret-summary-v1'), id: IdSchema, saved: z.literal(true), lastFour: z.string().max(4) });
export type SecretSummary = z.infer<typeof SecretSummarySchema>;

const PaidUseSchema = z.enum(['always', 'when-subscriptions-run-out', 'never']);
export const CredentialInputSchema = z.string().min(1).max(65_536);
export const AddAccountSchema = z.strictObject({
  schema: z.literal('add-account-v1'), runtime: IdSchema, label: z.string().trim().min(1).max(128),
  kind: z.enum(['subscription', 'api-key']), ceilingPct: z.number().min(0).max(100).default(90),
  paidUse: PaidUseSchema.optional(), secret: CredentialInputSchema.optional(), clientRequestId: IdSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'api-key' && (!value.paidUse || !value.secret)) ctx.addIssue({ code: 'custom', message: 'Enter the key and choose when Jevellan may use it.' });
  if (value.kind === 'subscription' && value.paidUse) ctx.addIssue({ code: 'custom', message: 'Paid-use policy applies only to API keys.' });
  if (value.runtime === 'codex' && value.kind === 'subscription' && value.secret) ctx.addIssue({ code: 'custom', message: 'Codex subscription sign-in belongs to this device.' });
});
export const UpdateAccountSchema = z.strictObject({
  schema: z.literal('update-account-v1'), revision: z.number().int().positive(), label: z.string().trim().min(1).max(128),
  enabled: z.boolean(), ceilingPct: z.number().min(0).max(100), paidUse: PaidUseSchema.optional(), clientRequestId: IdSchema.optional(),
});
export const ReplaceCredentialSchema = z.strictObject({ schema: z.literal('replace-credential-v1'), revision: z.number().int().positive(), secret: CredentialInputSchema, clientRequestId: IdSchema.optional() });
export const AccountViewSchema = z.strictObject({
  schema: z.literal('account-view-v1'), revision: z.number().int().positive(), account: AccountSchema,
  statuses: z.array(AccountStatusSchema), secret: SecretSummarySchema.optional(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;
export const OfferedModelsSchema = z.strictObject({
  schema: z.literal('offered-models-v1'), runtime: IdSchema, accountId: IdSchema, observedAt: TimestampSchema,
  models: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1), efforts: z.array(EffortSchema).min(1) })),
});
export const AccountProbeSchema = z.strictObject({ auth: AuthSchema, usage: AccountUsageSchema.optional(), identity: AccountSchema.shape.identity, error: z.string().optional() });
export const LoginViewSchema = z.strictObject({
  schema: z.literal('login-view-v1'), id: IdSchema, accountId: IdSchema, deviceId: IdSchema,
  state: z.enum(['pending', 'checking', 'done', 'failed', 'cancelled']), instructions: z.string(),
  url: z.url().optional(), userCode: z.string().optional(), acceptsCode: z.boolean(), error: z.string().optional(),
});
export const RiggingEntrySchema = z.strictObject({
  schema: z.literal('rigging-entry-v1'), id: IdSchema, name: z.string().trim().min(1).max(128),
  kind: RiggingItemSchema.shape.kind, state: RiggingItemSchema.shape.state,
  runtimes: z.record(IdSchema, z.boolean()), builtIn: z.boolean(), content: z.string().max(1024 * 1024),
  packageRef: z.string().min(1).max(2048).optional(), bundle: RiggingBundleSchema.optional(), promotionId: IdSchema.optional(), updatedAt: TimestampSchema,
});
export const AddRiggingSchema = z.strictObject({
  schema: z.literal('add-rigging-v1'), name: RiggingEntrySchema.shape.name, kind: RiggingItemSchema.shape.kind,
  runtimes: RiggingEntrySchema.shape.runtimes, content: RiggingEntrySchema.shape.content,
  packageRef: RiggingEntrySchema.shape.packageRef, clientRequestId: IdSchema.optional(),
});
export const UpdateRiggingSchema = z.strictObject({
  schema: z.literal('update-rigging-v1'), revision: z.number().int().positive(), name: RiggingEntrySchema.shape.name,
  runtimes: RiggingEntrySchema.shape.runtimes, content: RiggingEntrySchema.shape.content, state: RiggingEntrySchema.shape.state, clientRequestId: IdSchema.optional(),
});
export const RiggingViewSchema = z.strictObject({ schema: z.literal('rigging-view-v1'), revision: z.number().int().positive(), item: RiggingEntrySchema.omit({ bundle: true, promotionId: true }).extend({ bundle: RiggingBundleSummarySchema.optional() }) });

export const PassphraseInputSchema = z.strictObject({ schema: z.literal('passphrase-input-v1'), passphrase: z.string().min(8).max(1024) });
export const AuthStateSchema = z.strictObject({ schema: z.literal('auth-state-v1'), configured: z.boolean(), authenticated: z.boolean(), deviceId: IdSchema });

export const RiggingApplicationSchema = z.strictObject({
  schema: z.literal('rigging-application-v1'), at: z.iso.datetime({ offset: true }),
  accounts: z.array(z.strictObject({ accountId: z.string(), runtime: z.string(), results: z.array(z.strictObject({ itemId: z.string(), applied: z.boolean(), reason: z.string().optional() })), error: z.string().optional() })),
});
export const EmptySchema = z.strictObject({ schema: z.literal('empty-request-v1') });
export const LoginStartSchema = z.union([EmptySchema, z.strictObject({ schema: z.literal('login-start-v1'), clientRequestId: IdSchema })]);
export const ConfigWriteSchema = z.strictObject({ schema: z.literal('config-write-v1'), revision: z.number().int().nonnegative(), configuration: ConfigurationSchema, clientRequestId: IdSchema.optional() });
export const ImportSchema = z.strictObject({ schema: z.literal('config-import-v1'), yaml: z.string().max(1024 * 1024) });
export const LoginCodeSchema = z.strictObject({ schema: z.literal('login-code-v1'), code: z.string().min(1).max(16_384) });
export const SecretInputSchema = z.strictObject({ schema: z.literal('save-secret-v1'), clientRequestId: IdSchema.optional(), value: z.string().min(1).max(65_536) });
export const AccountListSchema = z.strictObject({ schema: z.literal('accounts-list-v1'), accounts: z.array(AccountViewSchema) });
export const RiggingListSchema = z.strictObject({ schema: z.literal('rigging-list-v1'), items: z.array(RiggingViewSchema), application: RiggingApplicationSchema.nullable() });
export const CapabilitiesSchema = z.strictObject({ edit: z.boolean(), shell: z.boolean(), mcp: z.boolean(), images: z.boolean(), interrupt: z.boolean(), usage: z.boolean(), continueSession: z.boolean(), perLaunchConfig: z.boolean(), readOnlyEnforced: z.boolean(), turns: z.boolean() });
export const RuntimeListSchema = z.strictObject({ schema: z.literal('runtimes-list-v1'), runtimes: z.array(z.strictObject({ id: IdSchema, displayName: z.string(), enabled: z.boolean(), accountKinds: z.array(z.enum(['subscription', 'api-key'])), riggingKinds: z.array(z.enum(['skill', 'mcp', 'hook', 'rule', 'setting', 'command'])), capabilities: CapabilitiesSchema })), offered: z.array(OfferedModelsSchema) });


export const ConfigHistorySchema = z.strictObject({ schema: z.literal('config-history-v1'), revisions: z.array(ConfigRevisionSchema) });
export const ConfigPreviewSchema = z.strictObject({ schema: z.literal('config-preview-v1'), revision: z.number().int().positive(), configuration: ConfigurationSchema, before: z.string(), after: z.string(), changedPaths: z.array(z.string()) });
export const DevicesListSchema = z.strictObject({ schema: z.literal('devices-list-v1'), currentDeviceId: IdSchema, devices: z.array(DeviceSchema) });
export const SecretStateSchema = z.union([SecretSummarySchema, z.strictObject({ schema: z.literal('secret-state-v1'), id: IdSchema, saved: z.literal(false) })]);
export const GitHubTokenStateSchema = z.union([
  z.strictObject({ schema: z.literal('github-token-summary-v1'), id: z.literal('github'), saved: z.literal(true), lastFour: z.string().max(4), updatedAt: TimestampSchema }),
  z.strictObject({ schema: z.literal('secret-state-v1'), id: IdSchema, saved: z.literal(false) }),
]);
export type GitHubTokenState = z.infer<typeof GitHubTokenStateSchema>;
export const JevConnectionSchema = z.strictObject({ schema: z.literal('jev-connection-v2'), checkedAt: z.iso.datetime(), latencyMs: z.number().int().nonnegative(), configuredModel: z.string().min(1),
  status: z.enum(['connected', 'unavailable']), availableModels: z.array(z.string()), reason: z.string().optional() });
export const RiggingSaveSchema = z.strictObject({ schema: z.literal('rigging-save-v1'), item: RiggingViewSchema, application: RiggingApplicationSchema });
