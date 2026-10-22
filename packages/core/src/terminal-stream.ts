import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { TerminalOutputFrameSchema, TerminalSessionSchema, TerminalSnapshotSchema, type TerminalSession } from './terminal-schemas.js';

export const TerminalStreamPolicySchema = z.strictObject({ schema: z.literal('terminal-stream-policy-v1'), initialRetryMs: z.number().int().positive(),
  maxRetryMs: z.number().int().positive(), retryFactor: z.number().int().min(1), heartbeatMs: z.number().int().positive(),
  labels: z.strictObject({ connecting: z.string(), connected: z.string(), reconnecting: z.string(), unavailable: z.string(), closed: z.string() }) })
  .refine(policy => policy.maxRetryMs >= policy.initialRetryMs, 'The retry cap must allow the initial delay.');
export function terminalStreamPolicy() {
  return TerminalStreamPolicySchema.parse({ schema: 'terminal-stream-policy-v1', initialRetryMs: 500, maxRetryMs: 5000, retryFactor: 2, heartbeatMs: 15000,
    labels: { connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', unavailable: 'Terminal unavailable.', closed: 'Closed' } });
}
export const TerminalStreamStateSchema = z.strictObject({ schema: z.literal('terminal-stream-state-v1'), sessionId: IdSchema, session: TerminalSessionSchema.nullable(),
  status: z.string(), connected: z.boolean(), approximate: z.boolean(), terminalClosed: z.boolean(), retryDelayMs: z.number().int().positive(), policy: TerminalStreamPolicySchema })
  .refine(state => (!state.session || state.session.id === state.sessionId) && state.retryDelayMs >= state.policy.initialRetryMs && state.retryDelayMs <= state.policy.maxRetryMs, 'The terminal state must bind its resource and retry allowance.');
export type TerminalStreamState = z.infer<typeof TerminalStreamStateSchema>;
const refuse = () => Object.assign(new Error('The terminal view belongs to another resource.'), { status: 409 });
export function terminalStreamInitial(sessionId: string, rawSession?: unknown): TerminalStreamState {
  const session = rawSession === undefined ? null : TerminalSessionSchema.parse(rawSession), policy = terminalStreamPolicy();
  if (session && session.id !== sessionId) throw refuse();
  return TerminalStreamStateSchema.parse({ schema: 'terminal-stream-state-v1', sessionId, session, policy, connected: false, approximate: false,
    terminalClosed: session?.status === 'closed', status: session?.status === 'closed' ? session.closedReason ?? policy.labels.closed : policy.labels.connecting, retryDelayMs: policy.initialRetryMs });
}
export const TerminalStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ schema: z.literal('terminal-stream-event-v1'), type: z.literal('ticket'), session: TerminalSessionSchema }),
  z.strictObject({ schema: z.literal('terminal-stream-event-v1'), type: z.literal('opened') }),
  z.strictObject({ schema: z.literal('terminal-stream-event-v1'), type: z.literal('errored') }),
  z.strictObject({ schema: z.literal('terminal-stream-event-v1'), type: z.literal('transport-closed') }),
  z.strictObject({ schema: z.literal('terminal-stream-event-v1'), type: z.literal('ticket-failed'), message: z.string() }),
]);
export const TerminalStreamEffectSchema = z.discriminatedUnion('type', [
  z.strictObject({ schema: z.literal('terminal-stream-effect-v1'), type: z.literal('reset') }),
  z.strictObject({ schema: z.literal('terminal-stream-effect-v1'), type: z.literal('write'), data: z.string().max(65536) }),
  z.strictObject({ schema: z.literal('terminal-stream-effect-v1'), type: z.literal('close') }),
  z.strictObject({ schema: z.literal('terminal-stream-effect-v1'), type: z.literal('retry'), delayMs: z.number().int().positive() }),
  z.strictObject({ schema: z.literal('terminal-stream-effect-v1'), type: z.literal('heartbeat-start'), intervalMs: z.number().int().positive() }),
  z.strictObject({ schema: z.literal('terminal-stream-effect-v1'), type: z.literal('heartbeat-stop') }),
  z.strictObject({ schema: z.literal('terminal-stream-effect-v1'), type: z.literal('cancel-retry') }),
]);
export type TerminalStreamEffect = z.infer<typeof TerminalStreamEffectSchema>;
export const TerminalStreamTransitionSchema = z.strictObject({ schema: z.literal('terminal-stream-transition-v1'), state: TerminalStreamStateSchema, effects: z.array(TerminalStreamEffectSchema) });
export type TerminalStreamTransition = z.infer<typeof TerminalStreamTransitionSchema>;
const effect = <T extends TerminalStreamEffect['type']>(type: T) => ({ schema: 'terminal-stream-effect-v1' as const, type });
const transition = (state: TerminalStreamState, effects: TerminalStreamEffect[] = []): TerminalStreamTransition => ({ schema: 'terminal-stream-transition-v1', state, effects });
const closedStatus = (state: TerminalStreamState) => state.session?.closedReason ?? state.status;
function retry(current: TerminalStreamState, status: string): TerminalStreamTransition {
  const effects: TerminalStreamEffect[] = [effect('heartbeat-stop')];
  if (current.terminalClosed) return transition({ ...current, connected: false, status: closedStatus(current) }, effects);
  effects.push({ ...effect('retry'), delayMs: current.retryDelayMs });
  return transition({ ...current, connected: false, status, retryDelayMs: Math.min(current.policy.maxRetryMs, current.retryDelayMs * current.policy.retryFactor) }, effects);
}
/** IO disposal is an adapter concern. A closed resource may still open its one history-replay stream. */
export function terminalStreamEvent(current: TerminalStreamState, raw: unknown): TerminalStreamTransition {
  const event = TerminalStreamEventSchema.parse(raw);
  if (event.type === 'ticket') {
    if (event.session.id !== current.sessionId) throw refuse();
    const terminalClosed = current.terminalClosed || event.session.status === 'closed';
    const session: TerminalSession = terminalClosed && event.session.status !== 'closed' ? { ...event.session, status: 'closed', closedReason: closedStatus(current) } : event.session;
    return transition({ ...current, session, terminalClosed, ...(terminalClosed ? { connected: false, status: session.closedReason ?? current.policy.labels.closed } : {}) });
  }
  if (event.type === 'opened') return transition({ ...current, connected: !current.terminalClosed, retryDelayMs: current.policy.initialRetryMs,
    status: current.terminalClosed ? closedStatus(current) : current.policy.labels.connected }, current.terminalClosed ? [] : [{ ...effect('heartbeat-start'), intervalMs: current.policy.heartbeatMs }]);
  if (event.type === 'errored') return transition({ ...current, status: current.terminalClosed ? closedStatus(current) : current.policy.labels.reconnecting });
  return retry(current, event.type === 'ticket-failed' ? event.message || current.policy.labels.unavailable : current.policy.labels.reconnecting);
}
export function terminalStreamHeartbeat(state: TerminalStreamState): { schema: 'terminal-frame-v1'; type: 'heartbeat' } | null {
  return state.connected && !state.terminalClosed ? { schema: 'terminal-frame-v1', type: 'heartbeat' } : null;
}
/** Parse one frame and emit transient renderer effects. Neither the state nor a global cache stores terminal output. */
export function terminalStreamReceive(current: TerminalStreamState, raw: string): TerminalStreamTransition {
  let source: unknown; try { source = JSON.parse(raw); } catch { return transition(current, [effect('close')]); }
  const parsed = TerminalOutputFrameSchema.safeParse(source); if (!parsed.success) return transition(current, [effect('close')]);
  const frame = parsed.data;
  if (frame.type === 'replay-start') {
    if (frame.session.id !== current.sessionId) return transition(current, [effect('close')]);
    const terminalClosed = current.terminalClosed || frame.session.status === 'closed';
    const session: TerminalSession = terminalClosed && frame.session.status !== 'closed' ? { ...frame.session, status: 'closed', closedReason: closedStatus(current) } : frame.session;
    return transition({ ...current, session, terminalClosed, ...(terminalClosed ? { connected: false, status: session.closedReason ?? current.policy.labels.closed } : {}) },
      [effect('reset'), ...(terminalClosed ? [effect('heartbeat-stop')] : [])]);
  }
  if (frame.type === 'output') {
    try { return transition(current, [{ ...effect('write'), data: atob(frame.data) }]); }
    catch { return transition(current, [effect('close')]); }
  }
  if (frame.type === 'replay-end') return transition({ ...current, approximate: frame.approximate });
  if (frame.type === 'closed') return transition({ ...current, connected: false, terminalClosed: true, status: frame.reason,
    session: current.session ? { ...current.session, status: 'closed', closedReason: frame.reason } : null }, [effect('heartbeat-stop'), effect('close')]);
  return transition(current);
}
export const TerminalReadRequestSchema = z.strictObject({ schema: z.literal('terminal-read-request-v1'), sessionId: IdSchema });
export const TerminalReadViewSchema = z.strictObject({ schema: z.literal('terminal-read-view-v1'), request: TerminalReadRequestSchema,
  snapshot: TerminalSnapshotSchema, policy: TerminalStreamPolicySchema, initial: TerminalStreamStateSchema })
  .refine(view => view.request.sessionId === view.snapshot.session.id && view.initial.sessionId === view.request.sessionId
    && JSON.stringify(view.initial.policy) === JSON.stringify(view.policy), 'The terminal read view must bind its resource and policy.');
export function terminalReadView(rawRequest: unknown, rawSnapshot: unknown) {
  const request = TerminalReadRequestSchema.parse(rawRequest), snapshot = TerminalSnapshotSchema.parse(rawSnapshot);
  if (request.sessionId !== snapshot.session.id) throw refuse();
  const initial = terminalStreamInitial(request.sessionId, snapshot.session);
  return TerminalReadViewSchema.parse({ schema: 'terminal-read-view-v1', request, snapshot, policy: initial.policy, initial });
}
