import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { CursorListSchema, CursorSessionIdSchema, CursorTranscriptSchema, type CursorSession } from './cursor-schemas.js';
import { nativeRuntimePresentation } from './native-conversation-policy.js';
type CursorTranscript = z.infer<typeof CursorTranscriptSchema>;

export const NativeReadingPolicySchema = z.strictObject({ schema: z.literal('native-reading-policy-v1'), listPollMs: z.number().int().positive(),
  transcriptPollMs: z.number().int().positive(), listFailureNotice: z.string(), openingLabel: z.string(), readFailureLabel: z.string(),
  stateLabels: z.strictObject({ reconnecting: z.string(), working: z.string(), idle: z.string(), unknown: z.string() }) });
export function nativeReadingPolicy() {
  return NativeReadingPolicySchema.parse({ schema: 'native-reading-policy-v1', listPollMs: 3000, transcriptPollMs: 1500,
    listFailureNotice: 'Native sessions are reconnecting.', openingLabel: 'Opening conversation…', readFailureLabel: 'Reconnecting to the session…',
    stateLabels: { reconnecting: 'Reconnecting', working: 'Working', idle: 'Idle', unknown: 'Activity unknown' } });
}
export const NativeSessionRefSchema = z.strictObject({ schema: z.literal('native-session-ref-v1'), id: CursorSessionIdSchema, ownerDeviceId: IdSchema, gatewayDeviceId: IdSchema });
export type NativeSessionRef = z.infer<typeof NativeSessionRefSchema>;
export const NativeSessionRefRequestSchema = z.strictObject({ schema: z.literal('native-session-ref-request-v1'), id: CursorSessionIdSchema,
  currentDeviceId: IdSchema, ownerDeviceId: IdSchema.optional(), gatewayDeviceId: IdSchema.optional() });
export function nativeSessionReadRef(raw: unknown): NativeSessionRef {
  const request = NativeSessionRefRequestSchema.parse(raw), gatewayDeviceId = request.gatewayDeviceId ?? request.currentDeviceId;
  return NativeSessionRefSchema.parse({ schema: 'native-session-ref-v1', id: request.id, gatewayDeviceId, ownerDeviceId: request.ownerDeviceId ?? gatewayDeviceId });
}
const ReadingErrorSchema = z.strictObject({ schema: z.literal('native-reading-error-v1'), message: z.string() });
export const NativeReadingPresentationSchema = z.strictObject({ schema: z.literal('native-reading-presentation-v1'), connected: z.boolean(), working: z.boolean(),
  stateLabel: z.string(), activityTitle: z.string(), liveText: z.string().nullable(), notice: z.string().nullable() });
type ReadingPolicy = z.infer<typeof NativeReadingPolicySchema>;
function presentation(view: CursorTranscript, error: string, policy: ReadingPolicy) {
  const connected = view.session.connected && !error, working = connected && view.session.state === 'working', latest = view.activity.at(-1)?.blocks.at(-1);
  return NativeReadingPresentationSchema.parse({ schema: 'native-reading-presentation-v1', connected, working,
    stateLabel: !connected ? policy.stateLabels.reconnecting : policy.stateLabels[view.session.state],
    activityTitle: view.session.state === 'working' ? 'Live updates' : 'Recent activity',
    liveText: working && nativeRuntimePresentation(view.session.runtime).canCompose ? `Cursor is working${latest?.type === 'tool' ? ` · Last tool: ${latest.name}` : latest?.type === 'thinking' ? ' · Thinking' : ''}` : null,
    notice: error ? `${error} Your last loaded messages remain below.` : null });
}
export function nativeUnavailableSession(session: CursorSession): CursorSession {
  return { ...session, connected: false, state: 'unknown', canSteer: false, canSend: false };
}
export const NativeListReadViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schema: z.literal('native-list-read-view-v1'), kind: z.literal('ready'), list: CursorListSchema, policy: NativeReadingPolicySchema }),
  z.strictObject({ schema: z.literal('native-list-read-view-v1'), kind: z.literal('failed'), error: ReadingErrorSchema, policy: NativeReadingPolicySchema }),
]);
export type NativeListReadView = z.infer<typeof NativeListReadViewSchema>;
export function nativeListReady(list: unknown, policy: unknown = nativeReadingPolicy()): NativeListReadView {
  return NativeListReadViewSchema.parse({ schema: 'native-list-read-view-v1', kind: 'ready', list, policy });
}
export function nativeListFailed(message: string, policy: unknown = nativeReadingPolicy()): NativeListReadView {
  return NativeListReadViewSchema.parse({ schema: 'native-list-read-view-v1', kind: 'failed', error: { schema: 'native-reading-error-v1', message }, policy });
}
const bound = (ref: NativeSessionRef, view: CursorTranscript) => ref.id === view.session.id && ref.ownerDeviceId === view.session.ownerDeviceId
  && (view.session.gatewayDeviceId === undefined || ref.gatewayDeviceId === view.session.gatewayDeviceId);
export const NativeTranscriptReadViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schema: z.literal('native-transcript-read-view-v1'), kind: z.literal('ready'), ref: NativeSessionRefSchema, view: CursorTranscriptSchema,
    policy: NativeReadingPolicySchema, presentation: NativeReadingPresentationSchema }),
  z.strictObject({ schema: z.literal('native-transcript-read-view-v1'), kind: z.literal('failed'), ref: NativeSessionRefSchema, error: ReadingErrorSchema, policy: NativeReadingPolicySchema }),
]).refine(frame => frame.kind !== 'ready' || bound(frame.ref, frame.view), 'The native view must belong to its requested resource.');
export type NativeTranscriptReadView = z.infer<typeof NativeTranscriptReadViewSchema>;
const refuse = () => Object.assign(new Error('The native view belongs to another resource.'), { status: 409 });
export function nativeTranscriptReady(rawRef: unknown, rawView: unknown, rawPolicy: unknown = nativeReadingPolicy()): Extract<NativeTranscriptReadView, { kind: 'ready' }> {
  const ref = NativeSessionRefSchema.parse(rawRef), source = CursorTranscriptSchema.parse(rawView), policy = NativeReadingPolicySchema.parse(rawPolicy);
  if (!bound(ref, source)) throw refuse();
  const view = { ...source, session: { ...source.session, gatewayDeviceId: ref.gatewayDeviceId } };
  // The source and small metadata are validated above; avoid parsing all transcript blocks again to compose this frame.
  return { schema: 'native-transcript-read-view-v1', kind: 'ready', ref, view, policy, presentation: presentation(view, '', policy) };
}
export function nativeTranscriptFailed(rawRef: unknown, message: string, rawPolicy: unknown = nativeReadingPolicy()): NativeTranscriptReadView {
  const ref = NativeSessionRefSchema.parse(rawRef), policy = NativeReadingPolicySchema.parse(rawPolicy);
  return { schema: 'native-transcript-read-view-v1', kind: 'failed', ref, error: ReadingErrorSchema.parse({ schema: 'native-reading-error-v1', message: message || policy.readFailureLabel }), policy };
}
export const NativeListReadingStateSchema = z.strictObject({ schema: z.literal('native-list-reading-state-v1'), list: CursorListSchema, policy: NativeReadingPolicySchema });
export type NativeListReadingState = z.infer<typeof NativeListReadingStateSchema>;
export function nativeListInitial(observedAt = new Date().toISOString()): NativeListReadingState {
  return { schema: 'native-list-reading-state-v1', list: CursorListSchema.parse({ schema: 'cursor-list-v1', observedAt: TimestampSchema.parse(observedAt), sessions: [], unavailable: [] }), policy: nativeReadingPolicy() };
}
/** Frames are already validated at the receiver boundary; no history is sent back to the service. */
export function applyNativeListRead(current: NativeListReadingState, frame: NativeListReadView): NativeListReadingState {
  const list = frame.kind === 'ready' ? frame.list : { ...current.list, unavailable: [frame.policy.listFailureNotice], sessions: current.list.sessions.map(nativeUnavailableSession) };
  return { schema: 'native-list-reading-state-v1', list, policy: frame.policy };
}
export const NativeTranscriptReadingStateSchema = z.strictObject({ schema: z.literal('native-transcript-reading-state-v1'), ref: NativeSessionRefSchema,
  view: CursorTranscriptSchema.nullable(), error: z.string(), policy: NativeReadingPolicySchema, presentation: NativeReadingPresentationSchema.nullable(), loadingLabel: z.string() })
  .refine(state => !state.view || bound(state.ref, state.view), 'The native reading state must belong to its resource.');
export type NativeTranscriptReadingState = z.infer<typeof NativeTranscriptReadingStateSchema>;
export function nativeTranscriptInitial(rawRef: unknown): NativeTranscriptReadingState {
  const ref = NativeSessionRefSchema.parse(rawRef), policy = nativeReadingPolicy();
  return { schema: 'native-transcript-reading-state-v1', ref, view: null, error: '', policy, presentation: null, loadingLabel: policy.openingLabel };
}
export function applyNativeTranscriptRead(current: NativeTranscriptReadingState, frame: NativeTranscriptReadView): NativeTranscriptReadingState {
  if (frame.ref.id !== current.ref.id || frame.ref.ownerDeviceId !== current.ref.ownerDeviceId || frame.ref.gatewayDeviceId !== current.ref.gatewayDeviceId) throw refuse();
  if (frame.kind === 'ready') return { schema: 'native-transcript-reading-state-v1', ref: current.ref, view: frame.view, error: '', policy: frame.policy, presentation: frame.presentation, loadingLabel: frame.policy.openingLabel };
  const error = frame.error.message || frame.policy.readFailureLabel;
  return { ...current, error, policy: frame.policy, presentation: current.view ? presentation(current.view, error, frame.policy) : null, loadingLabel: error };
}
