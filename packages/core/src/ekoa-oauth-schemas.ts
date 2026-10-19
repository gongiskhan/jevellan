import { z } from 'zod';
import { EkoaUrlSchema } from './ekoa-url-schema.js';
import { IdSchema, TimestampSchema } from './schemas.js';
export const EkoaOAuthStartSchema = z.strictObject({ schema: z.literal('ekoa-oauth-start-v1'), clientRequestId: IdSchema, url: EkoaUrlSchema });
export const EkoaOAuthCallbackSchema = z.strictObject({ schema: z.literal('ekoa-oauth-callback-v1'), state: z.string().min(20).max(200), code: z.string().min(1).max(4096).optional(), error: z.string().max(200).optional() });
export const EkoaOAuthStatusSchema = z.strictObject({ schema: z.literal('ekoa-oauth-status-v1'), connected: z.boolean(), connecting: z.boolean(), authorizationUrl: z.url().max(8000).optional(), reason: z.string().max(1200).optional() });
export const EkoaOAuthMetadataSchema = z.strictObject({ schema: z.literal('ekoa-oauth-metadata-v1'), issuer: EkoaUrlSchema, resource: EkoaUrlSchema,
  authorizationEndpoint: EkoaUrlSchema, tokenEndpoint: EkoaUrlSchema, registrationEndpoint: EkoaUrlSchema.nullable(), scopes: z.array(z.string().max(100)).max(50) });
const secret = z.string().min(1).max(8192);
export const EkoaOAuthVaultSchema = z.strictObject({ schema: z.literal('ekoa-oauth-vault-v1'), url: EkoaUrlSchema, redirectUri: EkoaUrlSchema,
  metadata: EkoaOAuthMetadataSchema, clientId: z.string().min(1).max(2000),
  pending: z.strictObject({ id: IdSchema, state: secret, verifier: secret, owner: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: TimestampSchema }).nullable(),
  completed: z.strictObject({ state: z.string().regex(/^[a-f0-9]{64}$/u), owner: z.string().regex(/^[a-f0-9]{64}$/u) }).optional(),
  tokens: z.strictObject({ accessToken: secret, refreshToken: secret, expiresAt: TimestampSchema, scope: z.string().max(1000) }).nullable() });
