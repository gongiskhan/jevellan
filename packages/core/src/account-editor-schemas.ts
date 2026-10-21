import { z } from 'zod';
import { AccountSchemaV2, EffortSchema, IdSchema, ACCOUNT_ENDPOINT_LIMITS } from './schemas.js';
import { AccountViewSchema, AddAccountSchema, UpdateAccountSchema, CredentialInputSchema } from './client-schemas.js';
import { ACCOUNT_ENDPOINT_COPY } from './account-policy.js';
const Kind = AccountSchemaV2.shape.kind;
const Option = z.strictObject({ value: z.string(), label: z.string() });
export const AccountEditorReadSchema = z.strictObject({ schema: z.literal('account-editor-read-v1'), runtime: IdSchema, accountId: IdSchema.optional(), mode: z.enum(['edit', 'replace-key']).optional() });
export const AccountEditorContextSchema = z.strictObject({ schema: z.literal('account-editor-context-v1'), mode: z.enum(['create', 'edit', 'replace-key']), runtime: IdSchema, accountId: IdSchema.nullable(), revision: z.number().int().nonnegative(), kind: Kind.nullable(), enabled: z.boolean() }).superRefine((value, ctx) => {
  if (value.mode === 'create' ? value.accountId !== null || value.revision !== 0 || value.kind !== null || !value.enabled : !value.accountId || value.revision < 1 || !value.kind) ctx.addIssue({ code: 'custom', message: 'Reload this account editor before saving.' });
});
export const AccountEndpointDraftSchema = z.strictObject({ baseUrl: z.string().max(10000), billing: z.enum(['subscription', 'metered', 'free']), backgroundModel: z.string().max(4000), models: z.array(z.strictObject({ id: z.string().max(4000), label: z.string().max(4000), efforts: z.array(EffortSchema).max(100), description: z.string().max(10000) })).min(1).max(ACCOUNT_ENDPOINT_LIMITS.models) });
export const AccountEditorFieldsSchema = z.strictObject({ label: z.string().max(10000), kind: Kind, ceilingPct: z.string().max(100), paidUse: z.enum(['', 'always', 'when-subscriptions-run-out', 'never']), endpoint: AccountEndpointDraftSchema });
export const AccountEditorCommandSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('add-model') }), z.strictObject({ kind: z.literal('remove-model'), index: z.number().int().nonnegative() }), z.strictObject({ kind: z.literal('select-kind'), value: Kind })]);
export const AccountEditorPreviewSchema = z.strictObject({ schema: z.literal('account-editor-preview-v1'), context: AccountEditorContextSchema, fields: AccountEditorFieldsSchema, credentialPresent: z.boolean(), command: AccountEditorCommandSchema.optional() });
export const AccountEditorSaveSchema = z.strictObject({ schema: z.literal('account-editor-save-v1'), context: AccountEditorContextSchema, fields: AccountEditorFieldsSchema, credential: CredentialInputSchema.optional(), clientRequestId: IdSchema });
const AddBody = z.strictObject({ schema: z.literal('add-account-v1'), runtime: IdSchema, label: AddAccountSchema.shape.label, kind: Kind, ceilingPct: AddAccountSchema.shape.ceilingPct, paidUse: AddAccountSchema.shape.paidUse, endpoint: AddAccountSchema.shape.endpoint });
const UpdateBody = z.strictObject({ schema: z.literal('update-account-v1'), revision: UpdateAccountSchema.shape.revision, label: UpdateAccountSchema.shape.label, enabled: z.boolean(), ceilingPct: UpdateAccountSchema.shape.ceilingPct, paidUse: UpdateAccountSchema.shape.paidUse, endpoint: UpdateAccountSchema.shape.endpoint });
const CredentialBody = z.strictObject({ schema: z.literal('replace-credential-v1'), revision: z.number().int().positive() });
const Write = z.strictObject({ schema: z.literal('account-editor-write-v1'), path: z.string().regex(/^\/hub\/accounts(?:\/[A-Za-z0-9_-]+(?:\/credential)?)?$/), method: z.enum(['POST', 'PATCH', 'PUT']), includeCredential: z.boolean(), body: z.discriminatedUnion('schema', [AddBody, UpdateBody, CredentialBody]) });
const EndpointCopy = z.strictObject(Object.fromEntries(Object.keys(ACCOUNT_ENDPOINT_COPY).map(key => [key, z.string()])) as { [K in keyof typeof ACCOUNT_ENDPOINT_COPY]: z.ZodString });
export const AccountEditorViewSchema = z.strictObject({ schema: z.literal('account-editor-view-v1'), context: AccountEditorContextSchema, fields: AccountEditorFieldsSchema,
  title: z.string(), submitLabel: z.string(), busyLabel: z.string(), cancelLabel: z.string(), showDetails: z.boolean(), currentRevision: z.number().int().nonnegative(), staleNotice: z.string().nullable(), reloadLabel: z.string(),
  inputs: z.strictObject({ label: z.strictObject({ label: z.string(), placeholder: z.string(), maxLength: z.number().int().positive() }), kind: z.strictObject({ label: z.string(), visible: z.boolean(), options: z.array(Option) }), ceiling: z.strictObject({ label: z.string(), min: z.number(), max: z.number(), step: z.literal('any') }) }),
  paid: z.strictObject({ visible: z.boolean(), label: z.string(), emptyLabel: z.string(), options: z.array(Option) }),
  credential: z.strictObject({ visible: z.boolean(), required: z.boolean(), label: z.string(), maxLength: z.number().int().positive(), detailsLabel: z.string().nullable(), help: z.string().nullable(), notice: z.string().nullable() }),
  endpoint: z.strictObject({ visible: z.boolean(), copy: EndpointCopy, limits: z.strictObject({ models: z.number().int().positive(), modelId: z.number().int().positive(), label: z.number().int().positive(), description: z.number().int().positive(), background: z.number().int().positive() }), efforts: z.array(Option), billing: z.array(Option), canAdd: z.boolean(), canRemove: z.boolean(), backgroundPlaceholder: z.string() }),
  validation: z.array(z.strictObject({ field: z.string(), message: z.string() })), canSave: z.boolean(),
  plan: z.strictObject({ schema: z.literal('account-editor-plan-v1'), primary: Write, credentialReplacement: Write.nullable(), startLogin: z.boolean() }).nullable(),
  request: z.strictObject({ previewPath: z.literal('/api/accounts/editor/preview'), savePath: z.literal('/api/accounts/editor/save') }),
});
export const AccountEditorSavedSchema = z.strictObject({ schema: z.literal('account-editor-saved-v1'), account: AccountViewSchema, startLogin: z.boolean() });
export type AccountEditorContext = z.infer<typeof AccountEditorContextSchema>;
export type AccountEditorFields = z.infer<typeof AccountEditorFieldsSchema>;
export type AccountEditorView = z.infer<typeof AccountEditorViewSchema>;
export type AccountEditorPreview = z.infer<typeof AccountEditorPreviewSchema>;
