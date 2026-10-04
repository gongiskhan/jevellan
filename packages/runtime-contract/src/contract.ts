import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AccountSchema, ActionSchema, EffortSchema, IdSchema, NativeProcessSchema, type Account, type AccountStatus, type Effort, type Homes, type RiggingItem, type SecretRedactor } from '@jevellan/core';

// scope 'model': a limit on the model that ran, not on the whole account. resetsAt: when the runtime reports it.
export const RuntimeErrorSchema = z.strictObject({ kind: z.enum(['rate-limit', 'auth', 'other']), message: z.string(), scope: z.enum(['account', 'model']).optional(), resetsAt: z.iso.datetime().optional() });
export const RuntimeEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), delta: z.string() }),
  z.strictObject({ type: z.literal('thinking'), delta: z.string() }),
  z.strictObject({ type: z.literal('tool-start'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.strictObject({ type: z.literal('tool-end'), id: z.string(), ok: z.boolean(), output: z.string().optional() }),
  z.strictObject({ type: z.literal('usage'), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative().optional(), cacheWriteTokens: z.number().int().nonnegative().optional(), costUsd: z.number().nonnegative().optional(), costSource: z.enum(['reported', 'estimated']).optional() }),
  z.strictObject({ type: z.literal('rate-limit'), fiveHourPct: z.number().min(0).max(100).optional(), weeklyPct: z.number().min(0).max(100).optional(), fiveHourResetsAt: z.iso.datetime({ offset: true }).optional(), weeklyResetsAt: z.iso.datetime({ offset: true }).optional() }),
  RuntimeErrorSchema.extend({ type: z.literal('error') }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
export const ResolvedAccountSchema = z.strictObject({ account: AccountSchema, home: z.string().min(1), env: z.record(z.string(), z.string()) });
export type ResolvedAccount = z.infer<typeof ResolvedAccountSchema>;
export const LaunchSchema = z.strictObject({ mcpServers: z.record(z.string(), z.strictObject({ command: z.string().min(1), args: z.array(z.string()), env: z.record(z.string(), z.string()) })), env: z.record(z.string(), z.string()) });
export const StretchInputSchema = z.strictObject({
  schema: z.literal('stretch-input-v1'), conversationId: IdSchema, stretch: z.number().int().positive(), action: ActionSchema,
  cwd: z.string().min(1), permissions: z.enum(['read-only', 'write']), memoryWrite: z.boolean(), systemAppend: z.string(), brief: z.string(),
  model: z.string().min(1), effort: EffortSchema, account: ResolvedAccountSchema,
  launch: LaunchSchema,
  timeoutMs: z.number().int().positive(), inputCopy: z.literal(true).optional(),
}).refine(value => !value.inputCopy || value.action === 'reply' && value.permissions === 'read-only' && !value.memoryWrite, 'Private input copies only support read-only replies.');
export type StretchInput = z.infer<typeof StretchInputSchema>;
// One worker process per turn; a later turn continues the native session through resume. id = projectId for the coordinator.
export const TurnOwnerSchema = z.strictObject({ kind: z.enum(['coordinator', 'thread']), projectId: IdSchema, id: IdSchema });
export const TurnInputSchema = z.strictObject({
  schema: z.literal('turn-input-v1'), owner: TurnOwnerSchema, turn: z.number().int().positive(),
  cwd: z.string().min(1).refine(isAbsolute, 'A turn needs an absolute working directory.'),
  permissions: z.enum(['read-only', 'write']), model: z.string().min(1), effort: EffortSchema,
  account: ResolvedAccountSchema, systemAppend: z.string(), prompt: z.string().min(1),
  resume: z.strictObject({ sessionId: z.string().min(1).max(256) }).optional(),
  launch: LaunchSchema, safetyProfile: z.enum(['coordinator', 'thread']), timeoutMs: z.number().int().positive(),
}).refine((value) => value.safetyProfile === value.owner.kind, 'The safety profile must match the turn owner.')
  .refine((value) => value.owner.kind === 'coordinator' ? value.permissions === 'read-only' && value.owner.id === value.owner.projectId : value.permissions === 'write', 'Coordinator turns are read-only and thread turns write.');
export type TurnInput = z.infer<typeof TurnInputSchema>;
export const RunResultSchema = z.strictObject({ status: z.enum(['completed', 'interrupted', 'failed']), error: RuntimeErrorSchema.optional() });
export type RunResult = z.infer<typeof RunResultSchema>;
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ schema: z.literal('runtime-message-v1'), type: z.literal('event'), event: RuntimeEventSchema }),
  z.strictObject({ schema: z.literal('runtime-message-v1'), type: z.literal('session'), sessionId: z.string().min(1).max(256) }),
  z.strictObject({ schema: z.literal('runtime-message-v1'), type: z.literal('result'), result: RunResultSchema }),
]);
export const WorkerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ schema: z.literal('runtime-command-v1'), type: z.literal('start'), input: StretchInputSchema, daemonPid: z.number().int().positive(), executable: z.string().optional() }),
  z.strictObject({ schema: z.literal('runtime-command-v1'), type: z.literal('start-turn'), input: TurnInputSchema, daemonPid: z.number().int().positive(), executable: z.string().optional() }),
  z.strictObject({ schema: z.literal('runtime-command-v1'), type: z.literal('continue'), message: z.string(), timeoutMs: z.number().int().positive() }),
  z.strictObject({ schema: z.literal('runtime-command-v1'), type: z.literal('interrupt'), reason: z.enum(['steer', 'timeout', 'cancel']) }),
]);
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

export interface StretchRun {
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly native: z.infer<typeof NativeProcessSchema>;
  readonly done: Promise<RunResult>;
  interrupt(reason: 'steer' | 'timeout' | 'cancel'): Promise<void>;
  continue(message: string, timeoutMs: number): Promise<void>;
  terminate(): Promise<void>;
}
export interface LoginSession {
  url?: string; userCode?: string; instructions: string; error?: string;
  validateCode?(code: string): void;
  submitCode?(code: string): Promise<void>;
  poll(): Promise<'pending' | 'done' | 'failed'>;
  cancel(): Promise<void>;
}
export type RuntimeContext = { homes: Homes; daemonPid?: number; executable?: string; redactor?: SecretRedactor; saveSecret?: (accountId: string, value: string, requestId?: string) => Promise<void> };
export interface RuntimeAdapter {
  id: string; displayName: string;
  accountKinds: Array<'subscription' | 'api-key'>;
  riggingKinds: Array<'skill' | 'mcp' | 'hook' | 'rule' | 'setting' | 'command'>;
  capabilities: { edit: boolean; shell: boolean; mcp: boolean; images: boolean; interrupt: boolean; usage: boolean; continueSession: boolean; perLaunchConfig: boolean; readOnlyEnforced: boolean; turns: boolean };
  listModels(account: ResolvedAccount): Promise<Array<{ id: string; label: string; efforts: Effort[] }>>;
  beginLogin(account: Account, home: string): Promise<LoginSession>;
  probe(account: ResolvedAccount): Promise<{ auth: AccountStatus['auth']; usage?: AccountStatus['usage']; identity?: Account['identity']; error?: string }>;
  materialiseRigging(home: string, items: RiggingItem[]): Promise<Array<{ itemId: string; applied: boolean; reason?: string }>>;
  startStretch(input: StretchInput): StretchRun;
  /** One project turn per run; continue() is refused. */
  startTurn(input: TurnInput): StretchRun;
}
