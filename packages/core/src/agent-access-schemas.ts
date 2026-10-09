import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { ProjectMailSchema } from './project-schemas.js';

const projectIds = z.array(IdSchema).min(1).max(1000).refine(values => new Set(values).size === values.length, 'Choose each project once.');
export const AgentConnectionSchema = z.strictObject({
  schema: z.literal('agent-connection-v1'), id: IdSchema, label: z.string().trim().min(1).max(120),
  createdAt: TimestampSchema, projectIds: projectIds.optional(), expiresAt: TimestampSchema.optional(),
  revokedAt: TimestampSchema.optional(), tokenSuffix: z.string().length(4),
});
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
export const AgentAccessCreateSchema = z.strictObject({
  schema: z.literal('agent-access-create-v1'), clientRequestId: IdSchema, label: z.string().trim().min(1).max(120),
  projectIds: projectIds.optional(), expiresAt: TimestampSchema.optional(),
});
export type AgentAccessCreate = z.infer<typeof AgentAccessCreateSchema>;
export const AgentAccessCreatedSchema = z.strictObject({
  schema: z.literal('agent-access-created-v1'), connection: AgentConnectionSchema,
  created: z.boolean(), token: z.string().max(256).optional(),
}).refine(value => value.created === (value.token !== undefined), 'Only a newly created connection returns its token.');
export const AgentAccessListSchema = z.strictObject({
  schema: z.literal('agent-access-list-v1'), connections: z.array(AgentConnectionSchema), mcpUrl: z.url(),
});
export const AgentAccessGrantSchema = z.strictObject({
  schema: z.literal('agent-access-grant-v1'), connectionId: IdSchema, label: z.string().min(1).max(120),
  projectIds: projectIds.optional(), expiresAt: TimestampSchema.optional(),
});
export type AgentAccessGrant = z.infer<typeof AgentAccessGrantSchema>;
export const AgentMailSendSchema = z.strictObject({ schema: z.literal('agent-mail-send-v1'), projectId: IdSchema,
  clientRequestId: IdSchema, to: IdSchema, subject: z.string().min(1).max(200), body: z.string().min(1).max(8000) });
export const AgentMailSentSchema = z.strictObject({ schema: z.literal('agent-mail-sent-v1'), mail: ProjectMailSchema, repeated: z.boolean() });
export const AgentMailListSchema = z.strictObject({ schema: z.literal('agent-mail-list-v1'), mail: z.array(ProjectMailSchema).max(100), next: IdSchema.nullable() });
export const AgentAccessCapabilitiesSchema = z.strictObject({
  schema: z.literal('agent-access-capabilities-v1'), mcpUrl: z.url(), authentication: z.literal('bearer'),
  tokenShownOnce: z.literal(true), stdioCommand: z.literal('jevellan mcp-server'),
  environment: z.strictObject({ url: z.literal('JEVELLAN_MCP_URL'), token: z.literal('JEVELLAN_MCP_TOKEN') }),
  supports: z.array(z.enum(['projects', 'conversations', 'threads', 'coordinators', 'messages', 'decisions', 'notebooks', 'mail', 'pull-requests', 'apps', 'resumable-output'])),
});

// Hub-only metadata; token material remains in the encrypted vault.
export const AgentAccessRecordSchema = z.strictObject({
  schema: z.literal('agent-access-record-v1'), connection: AgentConnectionSchema, tokenRef: IdSchema,
  tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/), clientRequestId: IdSchema,
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const AgentAccessHubRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('agent-access-hub-request-v1'), operation: z.literal('list'), ownerSession: z.string().max(4096) }),
  z.strictObject({ schema: z.literal('agent-access-hub-request-v1'), operation: z.literal('create'), ownerSession: z.string().max(4096), input: AgentAccessCreateSchema }),
  z.strictObject({ schema: z.literal('agent-access-hub-request-v1'), operation: z.literal('revoke'), ownerSession: z.string().max(4096), connectionId: IdSchema }),
  z.strictObject({ schema: z.literal('agent-access-hub-request-v1'), operation: z.literal('authenticate'), authorization: z.string().max(512) }),
  z.strictObject({ schema: z.literal('agent-access-hub-request-v1'), operation: z.literal('active'), connectionId: IdSchema }),
  z.strictObject({ schema: z.literal('agent-access-hub-request-v1'), operation: z.literal('mail-send'), authorization: z.string().max(512), input: AgentMailSendSchema }),
  z.strictObject({ schema: z.literal('agent-access-hub-request-v1'), operation: z.literal('mail-list'), authorization: z.string().max(512), projectId: IdSchema, after: IdSchema.optional() }),
]);
export const AgentAccessHubResultSchema = z.union([
  z.strictObject({ schema: z.literal('agent-access-connections-v1'), connections: z.array(AgentConnectionSchema) }),
  AgentAccessCreatedSchema, AgentConnectionSchema,
  AgentMailSentSchema, AgentMailListSchema,
  z.strictObject({ schema: z.literal('agent-access-authentication-v1'), grant: AgentAccessGrantSchema.nullable() }),
  z.strictObject({ schema: z.literal('agent-access-active-v1'), active: z.boolean() }),
]);
