import { ThreadSteeringViewSchema } from './project-thread-steering.js';
import { ProjectThreadDisplayTextSchema } from './project-thread-display.js';
import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { idTime, liveWork } from './project-rules.js';
import type { ThreadState } from './project-schemas.js';

export const ThreadReadPolicySchema = z.strictObject({ schema: z.literal('project-thread-read-policy-v1'),
  liveMs: z.number().int().positive(), restMs: z.number().int().positive(), afterActionMs: z.number().int().positive(), startingMs: z.number().int().positive() });
export type ThreadReadPolicy = z.infer<typeof ThreadReadPolicySchema>;
export const THREAD_READ_POLICY = ThreadReadPolicySchema.parse({ schema: 'project-thread-read-policy-v1', liveMs: 1500, restMs: 10000, afterActionMs: 6000, startingMs: 120000 });
export const ThreadReadHintSchema = z.strictObject({ schema: z.literal('project-thread-read-hint-v1'), pollHintMs: z.number().int().positive(), policy: ThreadReadPolicySchema });
export const ThreadUsageBadgeSchema = z.strictObject({ schema: z.literal('project-thread-usage-badge-v1'), tokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative() });
export const ThreadControlsSchema = z.strictObject({ schema: z.literal('project-thread-controls-v1'), browserTakeover: z.boolean(), attachPanel: z.boolean(),
  stop: z.strictObject({ title: z.string(), action: z.string(), body: z.string() }),
  discard: z.strictObject({ title: z.string(), action: z.string(), body: z.string(), notice: z.string() }), usage: ThreadUsageBadgeSchema.nullable() });
export type ThreadControls = z.infer<typeof ThreadControlsSchema>;
export const ThreadPresentationSchema = z.strictObject({ schema: z.literal('project-thread-presentation-v1'),
  actions: z.strictObject({ stop: z.boolean(), stopRefusal: z.string().nullable(), discard: z.boolean(), allowTurns: z.boolean(),
    allowTurnsStep: z.number().int().positive(), allowTurnsLabel: z.string(), allowedNotice: z.string() }),
  composer: z.strictObject({ steering: ThreadSteeringViewSchema.optional(), running: z.boolean(), ended: z.boolean(), block: z.string().nullable(), continueNotice: z.string().nullable() }),
  live: z.strictObject({ text: z.string().nullable(), activity: z.string().nullable() }), transcriptNotice: z.string().nullable(),
  reason: z.strictObject({ text: z.string(), restartedAs: IdSchema.nullable(), savedRef: z.string().nullable(), display: ProjectThreadDisplayTextSchema.optional() }).nullable(),
  readPolicy: ThreadReadPolicySchema, controls: ThreadControlsSchema.optional() });
export type ThreadPresentation = z.infer<typeof ThreadPresentationSchema>;

export const THREAD_POLL_LIVE_MS = THREAD_READ_POLICY.liveMs;
export const THREAD_POLL_REST_MS = THREAD_READ_POLICY.restMs;
/** How long the page keeps reading every 1.5 s after the owner acted, so the turn the action starts shows at once (D230). */
export const THREAD_POLL_AFTER_ACTION_MS = THREAD_READ_POLICY.afterActionMs;
/**
 * A thread page that finds no thread yet keeps loading while the thread is this young (D274): one placed on another device
 * exists there, and in the hub index, only once that device has read its start from the hub.
 */
export const THREAD_START_WAIT_MS = THREAD_READ_POLICY.startingMs;
export function threadStarting(threadId: string, now: number, policy: ThreadReadPolicy = THREAD_READ_POLICY): boolean {
  const at = idTime(threadId); return at !== null && Math.abs(now - at) < policy.startingMs;
}
/**
 * A thread view read that the thread's device could not answer before any view showed (D276): 409 when the device is offline
 * or left the mesh, a wait the page shows as a notice; 502 when it could not be reached, an error. The page then names the
 * thread from the project's index meanwhile. Other failures are no device's.
 */
export function deviceRefusal(status: number): 'notice' | 'error' | undefined {
  return status === 409 ? 'notice' : status === 502 ? 'error' : undefined;
}
export function threadPollDelay(state: ThreadState | undefined, now: number, fastUntil = 0, policy: ThreadReadPolicy = THREAD_READ_POLICY): number {
  return (state !== undefined && liveWork(state)) || now < fastUntil ? policy.liveMs : policy.restMs;
}
export function threadReadHint(state: ThreadState | undefined, now = Date.now(), fastUntil = 0, rawPolicy: unknown = THREAD_READ_POLICY) {
  const policy = ThreadReadPolicySchema.parse(rawPolicy);
  return ThreadReadHintSchema.parse({ schema: 'project-thread-read-hint-v1', pollHintMs: threadPollDelay(state, now, fastUntil, policy), policy });
}
