import { z } from 'zod';
import { CredentialInputSchema } from './client-schemas.js';
import { IdSchema, TimestampSchema } from './schemas.js';
import { UiSessionTokenSchema } from './mesh-schemas.js';
export const EkoaUrlSchema = z.url().max(2000).refine(raw => {
  let url: URL; try { url = new URL(raw); } catch { return false; } return !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}, 'Use an HTTPS MCP URL without credentials, query or fragment.');
export const EkoaSettingsSchema = z.strictObject({ schema: z.literal('ekoa-settings-v1'), revision: z.number().int().nonnegative(),
  url: z.union([EkoaUrlSchema, z.literal('')]), enabled: z.boolean() }).refine(value => !value.enabled || !!value.url, 'Add the MCP URL before enabling the mirror.');
export const EkoaSettingsInputSchema = z.strictObject({ schema: z.literal('ekoa-settings-input-v1'), clientRequestId: IdSchema, revision: z.number().int().nonnegative(),
  url: EkoaSettingsSchema.shape.url, enabled: z.boolean(), token: CredentialInputSchema.optional(), removeToken: z.boolean().optional() })
  .refine(value => !(value.token && value.removeToken), 'Replace or remove the token, not both.');
export const EkoaConnectionSchema = z.strictObject({ schema: z.literal('ekoa-connection-v1'), at: TimestampSchema,
  settingsRevision: z.number().int().nonnegative().default(0), attempts: z.number().int().nonnegative().default(0), retryAt: TimestampSchema.nullable().default(null),
  status: z.enum(['connected', 'blocked', 'unavailable']), tools: z.array(z.string().max(120)).max(300), reason: z.string().max(1200).optional() });
export const EkoaMirrorSchema = z.strictObject({ schema: z.literal('ekoa-mirror-v1'), id: IdSchema, projectId: IdSchema, kind: z.enum(['decision', 'pull-request', 'drafts']),
  jevellanId: IdSchema, title: z.string().max(200).optional(), endpoint: EkoaUrlSchema, marker: IdSchema, ekoaTaskId: z.string().min(1).max(200).nullable(),
  state: z.enum(['pending', 'open', 'completed']), createAttempted: z.boolean(), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  attempts: z.number().int().nonnegative(), retryAt: TimestampSchema.nullable(), error: z.string().max(1200).optional(), updatedAt: TimestampSchema });
export type EkoaMirror = z.infer<typeof EkoaMirrorSchema>;
export const EkoaStateSchema = z.strictObject({ schema: z.literal('ekoa-state-v1'), settings: EkoaSettingsSchema, tokenSaved: z.boolean(),
  connection: EkoaConnectionSchema.nullable(), mirrors: z.array(EkoaMirrorSchema).max(2000) });
export const EkoaRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('ekoa-request-v1'), operation: z.enum(['state', 'test']), ownerSession: UiSessionTokenSchema }),
  z.strictObject({ schema: z.literal('ekoa-request-v1'), operation: z.literal('save'), ownerSession: UiSessionTokenSchema, input: EkoaSettingsInputSchema }),
]);
export type EkoaRequest = z.infer<typeof EkoaRequestSchema>;
// MCP owns its negotiated wire version. Validate each result at the boundary before using this normalized document.
export const EkoaToolDataSchema = z.strictObject({ schema: z.literal('ekoa-tool-data-v1'), data: z.record(z.string(), z.unknown()), externalText: z.string().max(100_000) });
