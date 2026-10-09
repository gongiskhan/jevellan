import { z } from 'zod';
import { IdSchema } from '@jevellan/core';

export const AgentTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), projectId: IdSchema }),
  z.strictObject({ kind: z.literal('thread'), projectId: IdSchema, threadId: IdSchema }),
  z.strictObject({ kind: z.literal('conversation'), conversationId: IdSchema }),
]);
export type AgentTarget = z.infer<typeof AgentTargetSchema>;

/** Public output only. IDs belong to Jevellan, never to native agent sessions. */
export const AgentOutputEventSchema = z.strictObject({
  schema: z.literal('agent-output-event-v1'), id: z.number().int().positive(),
  kind: z.enum(['text', 'thinking', 'tool', 'status', 'report', 'decision', 'mail', 'notice']),
  blockId: z.string().min(1).max(200), turnId: z.string().max(200).optional(),
  groupId: z.string().min(1).max(200).optional(), role: z.enum(['user', 'assistant']).optional(), replace: z.boolean().optional(),
  toolName: z.string().max(200).optional(), text: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  input: z.string().optional(), output: z.string().optional(),
  state: z.string().max(100).optional(), data: z.unknown().optional(),
});
export type AgentOutputEvent = z.infer<typeof AgentOutputEventSchema>;
export const AgentEventPageSchema = z.strictObject({
  schema: z.literal('agent-event-page-v1'), events: z.array(AgentOutputEventSchema).max(200),
  nextCursor: z.number().int().nonnegative(), hasMore: z.boolean(), state: z.string().max(100).optional(),
});
export type AgentEventPage = z.infer<typeof AgentEventPageSchema>;

export const AgentOutputBlockSchema = z.strictObject({
  id: z.string().min(1).max(200), type: z.enum(['text', 'thinking', 'tools', 'status', 'report', 'decision', 'mail', 'notice']),
  toolName: z.string().max(200).optional(), continuation: z.boolean(),
  events: z.array(AgentOutputEventSchema), markdown: z.string(),
});
export type AgentOutputBlock = z.infer<typeof AgentOutputBlockSchema>;
export const AgentWatchCursorSchema = z.strictObject({
  schema: z.literal('agent-watch-cursor-v1'), target: AgentTargetSchema,
  after: z.number().int().nonnegative(),
  group: z.strictObject({ id: z.string().min(1).max(200), type: AgentOutputBlockSchema.shape.type, toolName: z.string().max(200).optional(), turnId: z.string().max(200).optional() }).optional(),
});
export type AgentWatchCursor = z.infer<typeof AgentWatchCursorSchema>;
export const AgentWatchRequestSchema = z.strictObject({
  target: AgentTargetSchema, cursor: z.string().max(4096).optional(),
  after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).default(100),
  waitMs: z.number().int().min(0).max(30_000).default(0),
  streamMs: z.number().int().min(0).max(30_000).default(0).describe('Keep the request open for this bounded window and stream incremental formatted progress. Total wait stays at most 30 seconds.'),
});
export type AgentWatchRequest = z.input<typeof AgentWatchRequestSchema>;
export const AgentWatchResultSchema = z.strictObject({
  schema: z.literal('agent-watch-result-v1'), target: AgentTargetSchema, cursor: z.string(), after: z.number().int().nonnegative(),
  blocks: z.array(AgentOutputBlockSchema), events: z.array(AgentOutputEventSchema).max(200),
  hasMore: z.boolean(), timedOut: z.boolean(), state: z.string().max(100).optional(), markdown: z.string(),
});
export type AgentWatchResult = z.infer<typeof AgentWatchResultSchema>;

/** Owner APIs validate their full document before returning it through this envelope. */
export const AgentToolResultSchema = z.strictObject({
  schema: z.literal('agent-tool-result-v1'), operation: z.string().min(1), data: z.unknown(), markdown: z.string(),
});
export const AgentErrorSchema = z.strictObject({ schema: z.literal('agent-error-v1'), code: z.string(), message: z.string() });

export interface AgentApi {
  /** A closed catalog, not a URL, shell command or unrestricted HTTP request. */
  call(operation: string, arguments_: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  events(target: AgentTarget, after: number, limit: number, signal: AbortSignal): Promise<AgentEventPage>;
  isActive(): Promise<boolean>;
  supportedOperations?: readonly string[];
}
