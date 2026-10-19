import { z } from 'zod';
import { EffortSchema, IdSchema, TimestampSchema } from './schemas.js';

/**
 * The owner tools (bridge specification, "Contracts"): views the engine computes for the twelve MCP tools, the status line and the
 * UI. They are views over existing stores, never new copies of threads, tasks, goals or decisions.
 */

/** Display ids the owner says out loud (`T31`), counted per project and never reused. */
export const ShortIdPrefixSchema = z.enum(['C', 'T', 'J', 'W', 'D', 'G', 'R', 'L', 'P', 'H']);
export type ShortIdPrefix = z.infer<typeof ShortIdPrefixSchema>;
export const ShortIdSchema = z.string().regex(/^(?:C|[TJWDGRLPH][1-9][0-9]{0,6})$/u);
// state point hub namespace owner-short-ids, key projectId
export const ProjectShortIdsSchema = z.strictObject({ schema: z.literal('project-short-ids-v1'), projectId: IdSchema,
  next: z.partialRecord(ShortIdPrefixSchema, z.number().int().positive()), ids: z.record(IdSchema, ShortIdSchema) });
export type ProjectShortIds = z.infer<typeof ProjectShortIdsSchema>;

export const RunLabelSchema = z.strictObject({ type: z.enum(['goal', 'job', 'manual']), name: z.string().min(1).max(200), goalId: IdSchema.optional() });
export type RunLabel = z.infer<typeof RunLabelSchema>;
export const RunStateSchema = z.enum(['waiting', 'held', 'running', 'landing', 'queued', 'landed', 'deployed', 'failed', 'stopped', 'cancelled', 'idle']);
export type RunState = z.infer<typeof RunStateSchema>;
const usage = z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative(), costUsdEstimate: z.number().nonnegative().nullable() });
export const RunViewSchema = z.strictObject({ schema: z.literal('run-view-v1'), id: ShortIdSchema, internalId: IdSchema, kind: z.enum(['coordinator', 'thread', 'job']),
  label: RunLabelSchema, title: z.string().min(1).max(200), state: RunStateSchema, detail: z.string().max(400).optional(),
  runtime: z.string().max(80).nullable(), model: z.string().max(120).nullable(), effort: EffortSchema.nullable(), account: z.string().max(120).nullable(), device: z.string().max(120).nullable(),
  startedAt: TimestampSchema.nullable(), endedAt: TimestampSchema.optional(), usage: usage.optional(),
  waitingItem: ShortIdSchema.optional(),
  held: z.strictObject({ since: TimestampSchema, via: z.enum(['remote_control', 'tmux']), tmuxSession: z.string().max(120) }).optional(),
  landing: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{7,64}$/u), at: TimestampSchema, method: z.string().max(40) }).optional(),
  position: z.number().int().positive().optional(), priority: z.enum(['urgent', 'normal']).optional() });
export type RunView = z.infer<typeof RunViewSchema>;

export const WaitingKindSchema = z.enum(['question', 'decision', 'deploy', 'deploy_failed', 'rollback_question', 'intake_pr', 'login', 'held_idle', 'other']);
export type WaitingKind = z.infer<typeof WaitingKindSchema>;
export const WaitingItemViewSchema = z.strictObject({ schema: z.literal('waiting-item-view-v1'), id: ShortIdSchema, internalId: IdSchema, kind: WaitingKindSchema,
  from: z.string().min(1).max(40), text: z.string().min(1).max(200000), options: z.array(z.string().min(1).max(120)).max(4), freeText: z.boolean(), urgent: z.boolean(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema, state: z.enum(['open', 'answered', 'expired']) });
export type WaitingItemView = z.infer<typeof WaitingItemViewSchema>;

export const GoalDueSchema = z.strictObject({ type: z.enum(['daily_item', 'idle_goal']), ref: z.string().max(200), text: z.string().max(400) });
export const GoalLineSchema = z.strictObject({ id: ShortIdSchema, internalId: IdSchema, title: z.string().max(200), state: z.string().max(40), priority: z.string().max(40).optional(),
  counts: z.strictObject({ running: z.number().int().nonnegative(), queued: z.number().int().nonnegative(), waiting: z.number().int().nonnegative(), landedToday: z.number().int().nonnegative() }),
  due: z.array(GoalDueSchema).max(20) });
export type GoalLine = z.infer<typeof GoalLineSchema>;

/** The whole status of a project at a moment, as the engine orders it; tools render it, the UI reads its parts. */
export const ProjectStatusViewSchema = z.strictObject({ schema: z.literal('project-status-view-v1'), projectId: IdSchema, project: z.string().min(1).max(200), at: TimestampSchema, timeZone: z.string().min(1).max(80),
  coordinator: z.strictObject({ state: z.enum(['running', 'idle', 'starting', 'stalled', 'crashed']), model: z.string().max(120).nullable(), effort: EffortSchema.nullable(), account: z.string().max(120).nullable() }),
  budgets: z.array(z.strictObject({ label: z.string().max(120), usedPercent: z.number().nonnegative().nullable(), budgetPercent: z.number().int().min(1).max(100) })).max(40),
  deploy: z.strictObject({ mode: z.string().max(40), paused: z.boolean(), undeployed: z.number().int().nonnegative(), message: ShortIdSchema.optional(), health: z.string().max(400).optional() }).nullable(),
  night: z.string().max(400).nullable(), quietHours: z.strictObject({ enabled: z.boolean(), start: z.string().max(5), end: z.string().max(5) }).nullable(),
  goals: z.array(GoalLineSchema).max(100), waiting: z.array(WaitingItemViewSchema), running: z.array(RunViewSchema), queued: z.array(RunViewSchema),
  landed: z.array(RunViewSchema), finished: z.array(RunViewSchema), goalFilter: z.strictObject({ id: ShortIdSchema, title: z.string().max(200), state: z.string().max(40), priority: z.string().max(40).optional() }).optional() });
export type ProjectStatusView = z.infer<typeof ProjectStatusViewSchema>;

export const SteeringRecordSchema = z.strictObject({ schema: z.literal('steering-record-v1'), id: IdSchema, projectId: IdSchema, at: TimestampSchema, thread: ShortIdSchema, threadId: IdSchema,
  kind: z.enum(['say', 'takeover', 'return', 'stop', 'auto_return']), text: z.string().max(20000).optional(),
  by: z.string().regex(/^(?:bridge|cli|ui|jevellan|remote:[A-Za-z0-9._@-]{1,120}|session:[A-Za-z0-9._-]{1,120})$/u), deliveredToCoordinator: z.boolean() });
export type SteeringRecord = z.infer<typeof SteeringRecordSchema>;

export const OwnerToolNameSchema = z.enum(['status', 'activity', 'ask_coordinator', 'work', 'goals', 'jobs', 'thread', 'respond', 'override', 'jev', 'config', 'login']);
export type OwnerToolName = z.infer<typeof OwnerToolNameSchema>;
export const OwnerCallerSchema = z.string().regex(/^(?:cli|ui|bridge:[A-Za-z0-9._-]{1,120}|session:[A-Za-z0-9._-]{1,120}|remote:[A-Za-z0-9._@-]{1,120})$/u);
export const CallerLogEntrySchema = z.strictObject({ schema: z.literal('caller-log-v1'), at: TimestampSchema, caller: OwnerCallerSchema, tool: OwnerToolNameSchema, action: z.string().min(1).max(60),
  access: z.enum(['read', 'write']), argsDigest: z.string().regex(/^[a-f0-9]{64}$/u), ok: z.boolean(), errorCode: z.string().max(60).optional(), projectId: IdSchema.optional() });
export type CallerLogEntry = z.infer<typeof CallerLogEntrySchema>;

export const OwnerToolRequestSchema = z.strictObject({ schema: z.literal('owner-tool-request-v1'), action: z.string().min(1).max(60).optional(),
  args: z.record(z.string(), z.unknown()).default({}), caller: OwnerCallerSchema, cwd: z.string().max(4096).optional(), project: z.string().max(200).optional() });
export type OwnerToolRequest = z.infer<typeof OwnerToolRequestSchema>;
export const OwnerToolResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ schema: z.literal('owner-tool-result-v1'), ok: z.literal(true), text: z.string().max(20000), data: z.unknown().optional() }),
  z.strictObject({ schema: z.literal('owner-tool-result-v1'), ok: z.literal(false), error: z.strictObject({ code: z.string().min(1).max(60), text: z.string().min(1).max(4000) }) }),
]);
export type OwnerToolResult = z.infer<typeof OwnerToolResultSchema>;

export const StatusLineRequestSchema = z.strictObject({ schema: z.literal('status-line-request-v1'), cwd: z.string().max(4096).optional(), project: z.string().max(200).optional() });
export const StatusLineViewSchema = z.strictObject({ schema: z.literal('status-line-view-v1'), text: z.string().max(300) });

/** One frame of the owner event stream (`jevellan watch`, the forwarder, the UI): `seq` is monotonic for resuming. */
export const OwnerEventSchema = z.strictObject({ schema: z.literal('owner-event-v1'), seq: z.number().int().positive(), at: TimestampSchema, projectId: IdSchema,
  source: z.string().min(1).max(20), kind: z.enum(['text', 'tool', 'done', 'think', 'decide', 'land', 'state', 'push']), text: z.string().max(4000) });
export type OwnerEvent = z.infer<typeof OwnerEventSchema>;
