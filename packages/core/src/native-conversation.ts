import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { CursorMessageSchema, CursorMessageModeSchema } from './cursor-schemas.js';
import { NativeSessionRefSchema, NativeTranscriptReadViewSchema, type NativeSessionRef, type NativeTranscriptReadingState } from './native-reading.js';
import { SessionListPreferencesSchema } from './session-list-schemas.js';
import { NativeRuntimePresentationSchema, nativeRuntimePresentation } from './native-conversation-policy.js';
import { MessageDeliveryViewSchema } from './conversation-reading-view-schemas.js';
import { messageDeliveryView } from './conversation-reading-view.js';

export const nativeSessionKey = (ref: NativeSessionRef) => `${ref.gatewayDeviceId}:${ref.ownerDeviceId}:${ref.id}`;
const sameRef = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionKey(a) === nativeSessionKey(b);
const refuse = () => Object.assign(new Error('The native message belongs to another resource.'), { status: 409 });
export const NativeViewerTitleRequestSchema = z.strictObject({ schema: z.literal('native-viewer-title-request-v1'), deviceId: IdSchema, ref: NativeSessionRefSchema });
export const NativeViewerTitleSchema = z.strictObject({ schema: z.literal('native-viewer-title-v1'), deviceId: IdSchema, ref: NativeSessionRefSchema,
  key: z.string(), revision: z.number().int().nonnegative(), titleOverride: z.string().trim().min(1).max(200).nullable() })
  .refine(value => value.key === nativeSessionKey(value.ref), 'The viewer title must belong to its requested resource.');
export type NativeViewerTitle = z.infer<typeof NativeViewerTitleSchema>;
/** Preferences have already been validated by their receiver; read only this resource's title. */
export function nativeViewerTitle(deviceId: string, prefs: z.infer<typeof SessionListPreferencesSchema>, ref: NativeSessionRef): NativeViewerTitle {
  const key = nativeSessionKey(ref);
  return NativeViewerTitleSchema.parse({ schema: 'native-viewer-title-v1', deviceId, ref, key, revision: prefs.revision, titleOverride: prefs.titles[key] ?? null });
}
export const NativeSendCommandSchema = z.strictObject({ schema: z.literal('native-conversation-command-v1'), operation: z.literal('send'), ref: NativeSessionRefSchema,
  payload: z.strictObject({ schema: z.literal('native-message-payload-v1'), clientMessageId: IdSchema, mode: CursorMessageModeSchema,
    text: z.string().refine(text => text.trim().length > 0 && text.trim().length <= 100_000, 'Enter a message of at most 100000 characters.') }) });
export const NativeCancelCommandSchema = z.strictObject({ schema: z.literal('native-conversation-command-v1'), operation: z.literal('cancel'), ref: NativeSessionRefSchema, clientMessageId: IdSchema });
export const NativeConversationCommandSchema = z.discriminatedUnion('operation', [NativeSendCommandSchema, NativeCancelCommandSchema]);
export type NativeConversationCommand = z.infer<typeof NativeConversationCommandSchema>;
export const NativeMessageReceiptSchema = z.strictObject({ schema: z.literal('native-message-receipt-v1'), ref: NativeSessionRefSchema, message: CursorMessageSchema })
  .refine(value => value.ref.id === value.message.sessionId, 'The receipt must belong to its requested session.');
export type NativeMessageReceipt = z.infer<typeof NativeMessageReceiptSchema>;
export const NativeMessageAttemptSchema = z.strictObject({ schema: z.literal('native-message-attempt-v1'), signature: z.string(), command: NativeSendCommandSchema });
export type NativeMessageAttempt = z.infer<typeof NativeMessageAttemptSchema>;
export function nativeMessageAttempt(previous: NativeMessageAttempt | null, ref: NativeSessionRef, text: string, mode: 'steer' | 'next', candidateId: string): NativeMessageAttempt {
  const signature = JSON.stringify([nativeSessionKey(ref), text, mode]);
  if (previous?.signature === signature) return previous;
  return NativeMessageAttemptSchema.parse({ schema: 'native-message-attempt-v1', signature,
    command: { schema: 'native-conversation-command-v1', operation: 'send', ref, payload: { schema: 'native-message-payload-v1', clientMessageId: candidateId, mode, text } } });
}
export function applyNativeMessageReceipt(current: NativeTranscriptReadingState, receipt: NativeMessageReceipt): NativeTranscriptReadingState {
  if (!sameRef(current.ref, receipt.ref) || receipt.message.sessionId !== current.ref.id) throw refuse();
  if (!current.view) return current;
  return { ...current, view: { ...current.view, messages: [...current.view.messages.filter(message => message.clientMessageId !== receipt.message.clientMessageId), receipt.message] } };
}
export const NativeConversationPresentationSchema = z.strictObject({ schema: z.literal('native-conversation-presentation-v1'), ref: NativeSessionRefSchema,
  key: z.string(), title: z.string(), latestUserMessage: z.string().nullable(), runtime: NativeRuntimePresentationSchema,
  composer: z.strictObject({ visible: z.boolean(), running: z.boolean(), primaryMode: CursorMessageModeSchema, canSteer: z.boolean(), canSend: z.boolean(), delivery: MessageDeliveryViewSchema }),
  deliveries: z.array(z.strictObject({ message: CursorMessageSchema, modeLabel: z.string(), stateLabel: z.string(), canCancel: z.boolean(), cancel: NativeCancelCommandSchema.nullable() })) });
export type NativeConversationPresentation = z.infer<typeof NativeConversationPresentationSchema>;
/** Reading state is receiver-validated. Do not parse its transcript again to derive small render metadata. */
export function nativeConversationPresentation(reading: NativeTranscriptReadingState, viewer: NativeViewerTitle): NativeConversationPresentation | null {
  if (!sameRef(reading.ref, viewer.ref)) throw refuse();
  const view = reading.view; if (!view) return null;
  const runtime = nativeRuntimePresentation(view.session.runtime), connected = reading.presentation?.connected ?? false;
  const running = view.session.state === 'working', canSteer = connected && runtime.canCompose && view.session.canSteer, canSend = connected && runtime.canCompose && view.session.canSend;
  const latest = view.turns.findLast(turn => turn.role === 'user' && !turn.automated && turn.blocks.some(block => block.type === 'text' && block.text.trim()));
  return { schema: 'native-conversation-presentation-v1', ref: reading.ref, key: nativeSessionKey(reading.ref), title: viewer.titleOverride ?? view.session.title,
    latestUserMessage: latest?.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? null, runtime,
    composer: { visible: runtime.canCompose, running, primaryMode: running ? 'steer' : 'next', canSteer, canSend, delivery: messageDeliveryView({ running, canSteer, canSend, cursor: true }) },
    deliveries: view.messages.filter(message => message.state !== 'cancelled').map(message => {
      const canCancel = message.state === 'queued' && connected;
      return { message, modeLabel: message.mode === 'steer' ? 'Steer' : 'Message', stateLabel: message.state === 'queued' ? 'Queued' : message.state === 'handed-to-cursor' ? 'Handed to Cursor' : 'Not sent — the turn ended or changed',
        canCancel, cancel: canCancel ? { schema: 'native-conversation-command-v1', operation: 'cancel', ref: reading.ref, clientMessageId: message.clientMessageId } : null };
    }) };
}
export const NativeMessageAdmissionSchema = z.strictObject({ schema: z.literal('native-message-admission-v1'), allowed: z.boolean(), mode: CursorMessageModeSchema });
export function nativeMessageAdmission(model: NativeConversationPresentation | null, text: string, mode: 'steer' | 'next', busy: boolean) {
  return NativeMessageAdmissionSchema.parse({ schema: 'native-message-admission-v1', mode,
    allowed: !!text.trim() && !busy && !!model?.composer.visible && (mode === 'steer' ? model.composer.canSteer : model.composer.canSend) });
}
export const NativeConversationReadViewSchema = z.strictObject({ schema: z.literal('native-conversation-read-view-v1'), reading: NativeTranscriptReadViewSchema,
  viewer: NativeViewerTitleSchema, presentation: NativeConversationPresentationSchema.nullable() });
