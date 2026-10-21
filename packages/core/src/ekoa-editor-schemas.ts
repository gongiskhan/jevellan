import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { CredentialInputSchema } from './client-schemas.js';
import { EkoaStateSchema, EkoaSettingsInputSchema } from './ekoa-schemas.js';
export const EkoaEditorFieldsSchema = z.strictObject({ url: z.string().max(8000), enabled: z.boolean() });
const operation = z.enum(['save', 'remove-token']);
export const EkoaEditorPreviewSchema = z.strictObject({ schema: z.literal('ekoa-editor-preview-v1'), revision: z.number().int().nonnegative(), fields: EkoaEditorFieldsSchema, operation, credentialPresent: z.boolean() });
export const EkoaEditorSaveSchema = z.strictObject({ schema: z.literal('ekoa-editor-save-v1'), revision: z.number().int().nonnegative(), fields: EkoaEditorFieldsSchema, operation, credential: CredentialInputSchema.optional(), clientRequestId: IdSchema });
export const EkoaEditorConnectSchema = z.strictObject({ schema: z.literal('ekoa-editor-connect-v1'), url: EkoaEditorFieldsSchema.shape.url, clientRequestId: IdSchema });
export const EkoaEditorSchema = z.strictObject({ schema: z.literal('ekoa-editor-v1'), state: EkoaStateSchema, fields: EkoaEditorFieldsSchema,
  title: z.string(), heading: z.string(), intro: z.string(), tokenHelp: z.string(), connectLabel: z.string(), mirrorLabel: z.string(), savedNotice: z.string(),
  connect: z.strictObject({ defaultUrl: z.url(), authorizationUrl: z.url().max(8000).optional(), failure: z.string() }),
  write: z.strictObject({ path: z.literal('/hub/ekoa/editor'), method: z.literal('PUT'), body: EkoaEditorSaveSchema.omit({ fields: true, operation: true, credential: true, clientRequestId: true }) }),
  urlRequired: z.boolean(), canSave: z.boolean(), validation: z.array(z.string()), plan: z.strictObject({ body: z.strictObject({ schema: EkoaSettingsInputSchema.shape.schema, revision: EkoaSettingsInputSchema.shape.revision, url: EkoaSettingsInputSchema.shape.url, enabled: EkoaSettingsInputSchema.shape.enabled, removeToken: EkoaSettingsInputSchema.shape.removeToken }), includeCredential: z.boolean() }).nullable(),
  presentation: z.strictObject({ oauthLine: z.string(), tokenLine: z.string(), tokenPlaceholder: z.string(),
    connection: z.strictObject({ title: z.string(), reason: z.string().optional(), tools: z.array(z.string()) }).nullable(),
    mirrorsLine: z.string(), mirrors: z.array(z.strictObject({ id: IdSchema, title: z.string(), state: z.enum(['pending', 'open', 'completed']) })), errors: z.array(z.strictObject({ id: IdSchema, message: z.string(), retryLine: z.string() })),
  }),
});
export type EkoaEditor = z.infer<typeof EkoaEditorSchema>;
