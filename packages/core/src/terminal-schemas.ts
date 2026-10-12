import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { UiSessionTokenSchema } from './mesh-schemas.js';
import { OwnerCommandSchema } from './owner-command-schemas.js';
import { OwnerCommandRunRequestSchema, OwnerCommandRunReceiptSchema } from './owner-command-schemas.js';

const folder = z.string().min(1).max(1024).refine(value => value.startsWith('/') && !/[\0\r\n]/u.test(value), 'Use an absolute folder.');
export const TerminalSessionSchema = z.strictObject({ schema: z.literal('terminal-session-v1'), id: IdSchema, deviceId: IdSchema,
  projectId: IdSchema.optional(), threadId: IdSchema.optional(), cwd: folder, title: z.string().min(1).max(120),
  createdAt: TimestampSchema, lastActivityAt: TimestampSchema, status: z.enum(['open', 'closed']), closedReason: z.string().max(300).optional() });
export const TerminalCommandSourceSchema = z.strictObject({ decisionId: IdSchema.optional(), threadId: IdSchema.optional(), coordinator: z.literal(true).optional() });
export const TerminalCommandSchema = z.strictObject({ schema: z.literal('terminal-command-v1'), sessionId: IdSchema, index: z.number().int().nonnegative(),
  command: z.string().max(8000), cwd: folder, exitCode: z.number().int().nullable(), startedAt: TimestampSchema, endedAt: TimestampSchema.nullable(),
  output: z.string().max(2 * 1024 * 1024), approximate: z.boolean(), fromOwnerCommand: TerminalCommandSourceSchema.optional() });
export const TerminalListSchema = z.strictObject({ schema: z.literal('terminal-list-v1'), sessions: z.array(TerminalSessionSchema).max(1000) });
export const TerminalSnapshotSchema = z.strictObject({ schema: z.literal('terminal-snapshot-v1'), session: TerminalSessionSchema,
  at: TimestampSchema, tail: z.string().max(30000), commands: z.array(TerminalCommandSchema.extend({ output: z.string().max(8000) })).max(20),
  approximate: z.boolean(), ownerCommand: z.strictObject({ key: z.string().length(64), receipt: OwnerCommandRunReceiptSchema }).optional() }).refine(value => value.commands.reduce((sum, command) => sum + command.output.length, 0) <= 30000, 'Terminal command output exceeds its allowance.');
export const OwnerCommandReceiptViewSchema = z.strictObject({ schema: z.literal('owner-command-receipt-view-v1'), receipt: OwnerCommandRunReceiptSchema.nullable() });
export const OwnerCommandReceiptRequestSchema = OwnerCommandRunRequestSchema.omit({ schema: true, clientRequestId: true }).extend({ schema: z.literal('owner-command-receipt-request-v1') });
export const TerminalCreateRequestSchema = z.strictObject({ schema: z.literal('terminal-create-request-v1'), clientRequestId: IdSchema,
  projectId: IdSchema.optional(), threadId: IdSchema.optional(), deviceId: IdSchema.optional(), cwd: OwnerCommandSchema.shape.cwd.default('checkout'),
  title: z.string().min(1).max(120).optional(), takeover: z.boolean().default(false) }).refine(value => !value.takeover || Boolean(value.threadId && value.projectId), 'Takeover needs a project thread.');
export const TerminalTicketSchema = z.strictObject({ schema: z.literal('terminal-ticket-v1'), session: TerminalSessionSchema, ticket: z.string().min(40).max(120), expiresAt: TimestampSchema });
export const TerminalReadInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.literal('commands'), sessionId: IdSchema, last: z.number().int().min(1).max(20).default(5) }),
  z.strictObject({ action: z.literal('tail'), sessionId: IdSchema, chars: z.number().int().min(1).max(30000).default(8000) }),
]);
export const TerminalReadResultSchema = z.union([TerminalListSchema,
  z.strictObject({ schema: z.literal('terminal-commands-v1'), sessionId: IdSchema, commands: z.array(TerminalCommandSchema.extend({ output: z.string().max(8000) })).max(20), approximate: z.boolean() }),
  z.strictObject({ schema: z.literal('terminal-tail-v1'), sessionId: IdSchema, output: z.string().max(30000) }),
]);
export const TerminalSendRequestSchema = z.strictObject({ schema: z.literal('terminal-send-request-v1'), clientMessageId: IdSchema,
  target: z.union([z.strictObject({ kind: z.literal('coordinator') }), z.strictObject({ kind: z.literal('thread'), threadId: IdSchema })]),
  content: z.enum(['last', 'last-five', 'selection']), selection: z.string().min(1).max(30000).optional() });
export const TerminalAckSchema = z.strictObject({ schema: z.literal('terminal-ack-v1'), ok: z.literal(true) });
export const TerminalInputFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('input'), data: z.string().max(65536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) }),
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('resize'), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) }),
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('heartbeat') }),
]);
export const TerminalOutputFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('output'), data: z.string().max(65536) }),
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('replay-start'), session: TerminalSessionSchema }),
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('replay-end'), approximate: z.boolean() }),
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('closed'), reason: z.string().max(300) }),
  z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('heartbeat') }),
]);
export const TerminalAccessSchema = z.union([
  z.strictObject({ kind: z.literal('owner'), ownerSession: UiSessionTokenSchema }),
  z.strictObject({ kind: z.literal('coordinator'), projectId: IdSchema }),
  z.strictObject({ kind: z.literal('thread'), projectId: IdSchema, threadId: IdSchema }),
]);
export const TerminalHubRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('terminal-hub-request-v1'), operation: z.literal('publish'), snapshot: TerminalSnapshotSchema }),
  z.strictObject({ schema: z.literal('terminal-hub-request-v1'), operation: z.literal('read'), access: TerminalAccessSchema, input: TerminalReadInputSchema }),
  z.strictObject({ schema: z.literal('terminal-hub-request-v1'), operation: z.literal('receipt'), ownerSession: UiSessionTokenSchema, key: z.string().length(64) }),
  z.strictObject({ schema: z.literal('terminal-hub-request-v1'), operation: z.literal('session'), ownerSession: UiSessionTokenSchema, sessionId: IdSchema }),
]);
export const TerminalHubResultSchema = z.union([TerminalAckSchema, TerminalReadResultSchema, OwnerCommandReceiptViewSchema, TerminalSnapshotSchema]);
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type TerminalCommand = z.infer<typeof TerminalCommandSchema>;
export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;
export type TerminalReadInput = z.infer<typeof TerminalReadInputSchema>;
export type TerminalReadResult = z.infer<typeof TerminalReadResultSchema>;
export type TerminalAccess = z.infer<typeof TerminalAccessSchema>;
export type TerminalHubRequest = z.infer<typeof TerminalHubRequestSchema>;
export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequestSchema>;
export const TerminalPeerRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('terminal-peer-request-v1'), operation: z.literal('create'), input: TerminalCreateRequestSchema }),
  z.strictObject({ schema: z.literal('terminal-peer-request-v1'), operation: z.literal('owner-command'), input: OwnerCommandRunRequestSchema }),
  z.strictObject({ schema: z.literal('terminal-peer-request-v1'), operation: z.literal('snapshot'), sessionId: IdSchema }),
  z.strictObject({ schema: z.literal('terminal-peer-request-v1'), operation: z.literal('close'), sessionId: IdSchema }),
]);
export const TerminalPeerResultSchema = z.union([TerminalSessionSchema, TerminalSnapshotSchema, TerminalAckSchema]);
