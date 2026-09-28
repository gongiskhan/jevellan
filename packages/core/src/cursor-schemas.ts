import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

export const CursorSessionIdSchema = z.string().regex(/^cursor_[a-f0-9]{32}$/);
export const CursorMessageModeSchema = z.enum(['steer', 'next']);
export const CursorSessionSchema = z.strictObject({
  schema: z.literal('cursor-session-v1'), id: CursorSessionIdSchema,
  ownerDeviceId: IdSchema, gatewayDeviceId: IdSchema.optional(), deviceName: z.string(), title: z.string(),
  cwd: z.string().nullable(), project: z.string(),
  state: z.enum(['working', 'idle', 'unknown']), lastActivityAt: TimestampSchema,
  connected: z.boolean(), canSteer: z.boolean(), canSend: z.boolean(),
});
export type CursorSession = z.infer<typeof CursorSessionSchema>;
export const CursorBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('thinking'), text: z.string() }),
  z.strictObject({ type: z.literal('tool'), id: z.string(), name: z.string(), input: z.string(),
    output: z.string().optional(), state: z.enum(['running', 'completed', 'failed', 'unknown']) }),
]);
export const CursorTurnSchema = z.strictObject({
  id: z.string(), role: z.enum(['user', 'assistant']), blocks: z.array(CursorBlockSchema),
});
export type CursorTurn = z.infer<typeof CursorTurnSchema>;
export const CursorMessageInputSchema = z.strictObject({
  schema: z.literal('cursor-message-input-v1'), clientMessageId: IdSchema,
  mode: CursorMessageModeSchema, text: z.string().trim().min(1).max(100_000),
});
export const CursorMessageSchema = CursorMessageInputSchema.extend({
  schema: z.literal('cursor-message-v1'), sessionId: CursorSessionIdSchema,
  createdAt: TimestampSchema, state: z.enum(['queued', 'handed-to-cursor', 'expired', 'cancelled']),
  generation: z.string(),
});
export type CursorMessage = z.infer<typeof CursorMessageSchema>;
export const CursorTranscriptSchema = z.strictObject({
  schema: z.literal('cursor-transcript-v1'), session: CursorSessionSchema,
  turns: z.array(CursorTurnSchema), messages: z.array(CursorMessageSchema),
  truncated: z.boolean(), observedAt: TimestampSchema,
  activity: z.array(CursorTurnSchema).default([]),
});
export const CursorActivitySchema = z.strictObject({
  schema: z.literal('cursor-activity-v1'), generation: z.string(),
  turns: z.array(CursorTurnSchema).max(40), observedAt: TimestampSchema,
});
export const CursorListSchema = z.strictObject({
  schema: z.literal('cursor-list-v1'), sessions: z.array(CursorSessionSchema),
  unavailable: z.array(z.string()), observedAt: TimestampSchema,
});
// Connections use an already established SSH leg of the user's dev tunnel.
// No tunnel process, port forwarding or remote listener is created here.
export const CursorConnectionSchema = z.strictObject({
  id: IdSchema, name: z.string().trim().min(1).max(120),
  port: z.number().int().min(1).max(65535), user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/i),
  identityFile: z.string().startsWith('/').max(4096).optional(),
  helperPath: z.string().startsWith('/').max(4096),
  nodePath: z.string().startsWith('/').max(4096),
  home: z.string().startsWith('/').max(4096),
  gateway: z.strictObject({
    host: z.string().regex(/^(?!-)[A-Za-z0-9._-]{1,253}$/),
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/i),
  }).optional(),
});
export const CursorConnectionsSchema = z.strictObject({
  schema: z.literal('cursor-connections-v1'), connections: z.array(CursorConnectionSchema).max(20),
}).refine(value => new Set(value.connections.map(row => row.id)).size === value.connections.length, 'Connection IDs must be unique.');
export type CursorConnection = z.infer<typeof CursorConnectionSchema>;
export const CursorHookStateSchema = z.strictObject({
  schema: z.literal('cursor-hook-state-v1'), id: CursorSessionIdSchema,
  nativeId: z.string().min(1).max(200), generation: z.string().max(300),
  cwd: z.string().nullable(), title: z.string(),
  state: z.enum(['working', 'idle', 'unknown']), at: TimestampSchema,
  hold: z.strictObject({ pid: z.number().int().positive(), generation: z.string(), until: TimestampSchema }).nullable(),
});
export const CursorHookPayloadSchema = z.object({
  conversation_id: z.string().min(1).max(200), generation_id: z.string().max(300).optional(),
  hook_event_name: z.string(), workspace_roots: z.array(z.string()).optional(),
  prompt: z.string().optional(), status: z.string().optional(),
  tool_name: z.string().optional(), tool_use_id: z.string().optional(), tool_input: z.unknown().optional(),
  tool_output: z.unknown().optional(), error_message: z.string().optional(), text: z.string().optional(),
});
export const CursorHookSetupSchema = z.strictObject({
  schema: z.literal('cursor-hook-setup-v1'), configuration: z.string(),
});
export const CursorHookInstallationSchema = z.strictObject({
  schema: z.literal('cursor-hook-installation-v1'), hookPath: z.string(), helperPath: z.string(),
  executable: z.string(), command: z.string(), installedAt: z.string(),
});
