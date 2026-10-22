import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { TerminalAckSchema, TerminalSendRequestSchema, TerminalSessionSchema, TerminalSnapshotSchema, type TerminalSession } from './terminal-schemas.js';
import { type TerminalStreamState, type TerminalStreamTransition } from './terminal-stream.js';

const COMMAND_LIMIT = 4000;
const refuse = (message: string, status = 409) => Object.assign(new Error(message), { status });
export const TerminalActionsPolicySchema = z.strictObject({ schema: z.literal('terminal-actions-policy-v1'), commandMaxLength: z.number().int().positive(),
  defaultTarget: z.string(), defaultContent: TerminalSendRequestSchema.shape.content, ownerClosedLabel: z.string(), sentLabel: z.string(), copiedLabel: z.string(), textSelectedLabel: z.string(), copyFailureLabel: z.string(),
  contentOptions: z.array(z.strictObject({ value: TerminalSendRequestSchema.shape.content, label: z.string() })) });
export function terminalActionsPolicy() {
  return TerminalActionsPolicySchema.parse({ schema: 'terminal-actions-policy-v1', commandMaxLength: COMMAND_LIMIT, defaultTarget: 'coordinator', defaultContent: 'last',
    ownerClosedLabel: 'Closed by the owner.', sentLabel: 'Sent', copiedLabel: 'Copied', textSelectedLabel: 'Text selected', copyFailureLabel: 'Select the text and use the browser’s Copy action.',
    contentOptions: [{ value: 'last', label: 'Last command' }, { value: 'last-five', label: 'Last 5 commands' }, { value: 'selection', label: 'Current selection' }] });
}
export const TerminalCopyRequestSchema = z.strictObject({ schema: z.literal('terminal-copy-request-v1'), sessionId: IdSchema, kind: z.enum(['all', 'last', 'five']) });
export const TerminalCopySnippetRequestSchema = TerminalCopyRequestSchema.extend({ kind: z.enum(['last', 'five']) });
export const TerminalCopyPlanSchema = z.strictObject({ schema: z.literal('terminal-copy-plan-v1'), request: TerminalCopyRequestSchema,
  source: z.enum(['buffer', 'snapshot']), last: z.union([z.literal(1), z.literal(5)]).nullable() })
  .refine(plan => plan.request.kind === 'all' ? plan.source === 'buffer' && plan.last === null : plan.source === 'snapshot' && plan.last === (plan.request.kind === 'last' ? 1 : 5), 'The copy plan must match its requested source.');
export type TerminalCopyPlan = z.infer<typeof TerminalCopyPlanSchema>;
export function terminalCopyPlan(raw: unknown): TerminalCopyPlan {
  const request = TerminalCopyRequestSchema.parse(raw);
  return TerminalCopyPlanSchema.parse({ schema: 'terminal-copy-plan-v1', request, source: request.kind === 'all' ? 'buffer' : 'snapshot', last: request.kind === 'all' ? null : request.kind === 'last' ? 1 : 5 });
}
export const TerminalCopySourceSchema = z.strictObject({ schema: z.literal('terminal-copy-source-v1'), buffer: z.string().optional(), snapshot: TerminalSnapshotSchema.optional() })
  .refine(source => (source.buffer !== undefined) !== (source.snapshot !== undefined), 'Provide one copy source.');
export const TerminalCopyViewSchema = z.strictObject({ schema: z.literal('terminal-copy-view-v1'), request: TerminalCopyRequestSchema, source: z.enum(['buffer', 'snapshot']), text: z.string() })
  .refine(view => view.source === (view.request.kind === 'all' ? 'buffer' : 'snapshot'), 'The copied text must use its requested source.');
/** The full rendered buffer is supplied by its own client adapter; it is never replaced with a bounded server tail. */
export function terminalCopyView(rawPlan: unknown, rawSource: unknown) {
  const plan = TerminalCopyPlanSchema.parse(rawPlan), source = TerminalCopySourceSchema.parse(rawSource);
  let text: string;
  if (plan.source === 'buffer') {
    if (source.buffer === undefined) throw refuse('Copy all uses this client’s visible terminal buffer.');
    text = source.buffer;
  } else {
    if (!source.snapshot || source.snapshot.session.id !== plan.request.sessionId) throw refuse('The copied commands belong to another terminal.');
    text = source.snapshot.commands.slice(-plan.last!).map(command => `$ ${command.command}\n${command.output}`).join('\n\n');
  }
  return TerminalCopyViewSchema.parse({ schema: 'terminal-copy-view-v1', request: plan.request, source: plan.source, text });
}
export function verifyTerminalCopyView(rawRequest: unknown, rawView: unknown) {
  const request = TerminalCopyRequestSchema.parse(rawRequest), view = TerminalCopyViewSchema.parse(rawView);
  if (request.sessionId !== view.request.sessionId || request.kind !== view.request.kind) throw refuse('The copied text belongs to another request.');
  return view;
}
export const TerminalCopyFeedbackSchema = z.strictObject({ schema: z.literal('terminal-copy-feedback-v1'), status: z.string(), select: z.boolean() });
export function terminalCopyFeedback(copied: boolean) { return TerminalCopyFeedbackSchema.parse({ schema: 'terminal-copy-feedback-v1', status: copied ? terminalActionsPolicy().copiedLabel : '', select: !copied }); }

export const TerminalSendCommandSchema = z.strictObject({ schema: z.literal('terminal-action-command-v1'), operation: z.literal('send'), sessionId: IdSchema, request: TerminalSendRequestSchema });
export const TerminalCloseCommandSchema = z.strictObject({ schema: z.literal('terminal-action-command-v1'), operation: z.literal('close'), sessionId: IdSchema });
export const TerminalActionCommandSchema = z.discriminatedUnion('operation', [TerminalSendCommandSchema, TerminalCloseCommandSchema]);
export type TerminalActionCommand = z.infer<typeof TerminalActionCommandSchema>;
export function terminalCloseCommand(sessionId: string) { return TerminalCloseCommandSchema.parse({ schema: 'terminal-action-command-v1', operation: 'close', sessionId }); }
export const TerminalActionsSourceSchema = z.strictObject({ schema: z.literal('terminal-actions-source-v1'), snapshot: TerminalSnapshotSchema,
  threads: z.array(z.strictObject({ id: IdSchema, title: z.string(), state: z.string() })) });
const SendTargetSchema = z.strictObject({ value: IdSchema, label: z.string(), target: TerminalSendRequestSchema.shape.target });
export const TerminalActionsViewSchema = z.strictObject({ schema: z.literal('terminal-actions-view-v1'), sessionId: IdSchema, session: TerminalSessionSchema,
  projectId: IdSchema.nullable(), canSend: z.boolean(), targets: z.array(SendTargetSchema), policy: TerminalActionsPolicySchema, copyPlans: z.array(TerminalCopyPlanSchema) })
  .refine(view => view.sessionId === view.session.id && view.projectId === (view.session.projectId ?? null) && view.canSend === !!view.projectId, 'Terminal actions must bind their resource.');
export type TerminalActionsView = z.infer<typeof TerminalActionsViewSchema>;
function actionsForSession(session: TerminalSession, threads: z.infer<typeof TerminalActionsSourceSchema>['threads']): TerminalActionsView {
  return TerminalActionsViewSchema.parse({ schema: 'terminal-actions-view-v1', sessionId: session.id, session, projectId: session.projectId ?? null, canSend: !!session.projectId,
    targets: session.projectId ? [{ value: 'coordinator', label: 'Coordinator', target: { kind: 'coordinator' } }, ...threads.filter(row => !['done', 'failed', 'stopped'].includes(row.state)).map(row => ({ value: row.id, label: row.title, target: { kind: 'thread', threadId: row.id } }))] : [],
    policy: terminalActionsPolicy(), copyPlans: (['all', 'last', 'five'] as const).map(kind => terminalCopyPlan({ schema: 'terminal-copy-request-v1', sessionId: session.id, kind })) });
}
export function terminalActionsView(raw: unknown): TerminalActionsView { const source = TerminalActionsSourceSchema.parse(raw); return actionsForSession(source.snapshot.session, source.threads); }
export function terminalActionsForSession(raw: unknown): TerminalActionsView { return actionsForSession(TerminalSessionSchema.parse(raw), []); }
/** Before or after a failed targets read, the known project session still offers its coordinator, as before. */
export function terminalActionsCurrent(session: TerminalSession | undefined, saved: TerminalActionsView | null): TerminalActionsView | null {
  if (!session) return null;
  return saved?.sessionId === session.id && saved.projectId === (session.projectId ?? null) ? { ...saved, session } : terminalActionsForSession(session);
}
export const TerminalSendChoiceSchema = z.strictObject({ schema: z.literal('terminal-send-choice-v1'), target: IdSchema,
  content: TerminalSendRequestSchema.shape.content, activeSelection: z.string(), selectionText: z.string() });
export const TerminalSendAttemptSchema = z.strictObject({ schema: z.literal('terminal-send-attempt-v1'), signature: z.string(), command: TerminalSendCommandSchema });
export type TerminalSendAttempt = z.infer<typeof TerminalSendAttemptSchema>;
export function terminalSendAttempt(previous: TerminalSendAttempt | null, view: TerminalActionsView, rawChoice: unknown, candidateId: string): TerminalSendAttempt {
  if (!view.canSend) throw refuse('Choose a project terminal to send its output.', 400);
  const choice = TerminalSendChoiceSchema.parse(rawChoice), selection = choice.activeSelection || choice.selectionText;
  if (choice.content === 'selection' && !selection) throw refuse('Select text to send.', 400);
  const signature = JSON.stringify([view.sessionId, choice.target, choice.content, choice.content === 'selection' ? selection : '']);
  if (previous?.signature === signature) return previous;
  return TerminalSendAttemptSchema.parse({ schema: 'terminal-send-attempt-v1', signature, command: { schema: 'terminal-action-command-v1', operation: 'send', sessionId: view.sessionId,
    request: { schema: 'terminal-send-request-v1', clientMessageId: candidateId, target: choice.target === 'coordinator' ? { kind: 'coordinator' } : { kind: 'thread', threadId: choice.target }, content: choice.content,
      ...(choice.content === 'selection' ? { selection } : {}) } } });
}
export const TerminalActionReceiptSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('terminal-action-receipt-v1'), operation: z.literal('send'), sessionId: IdSchema, clientMessageId: IdSchema, ack: TerminalAckSchema }),
  z.strictObject({ schema: z.literal('terminal-action-receipt-v1'), operation: z.literal('close'), sessionId: IdSchema, ack: TerminalAckSchema }),
]);
export function verifyTerminalActionReceipt(rawCommand: unknown, rawReceipt: unknown, currentSessionId?: string) {
  const command = TerminalActionCommandSchema.parse(rawCommand), receipt = TerminalActionReceiptSchema.parse(rawReceipt);
  if (command.sessionId !== receipt.sessionId || (currentSessionId ?? command.sessionId) !== command.sessionId || command.operation !== receipt.operation
    || command.operation === 'send' && receipt.operation === 'send' && command.request.clientMessageId !== receipt.clientMessageId) throw refuse('The terminal receipt belongs to another command.');
  return receipt;
}
export const TerminalRunRequestSchema = z.strictObject({ schema: z.literal('terminal-run-request-v1'), sessionId: IdSchema, text: z.string().max(COMMAND_LIMIT), transportOpen: z.boolean() });
const RunFrameSchema = z.strictObject({ schema: z.literal('terminal-frame-v1'), type: z.literal('input'),
  data: z.string().max(65536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) });
export const TerminalRunPlanSchema = z.strictObject({ schema: z.literal('terminal-run-plan-v1'), sessionId: IdSchema, allowed: z.boolean(), clearAfterSend: z.boolean(), frame: RunFrameSchema.nullable() })
  .refine(plan => plan.allowed === (plan.frame !== null) && plan.clearAfterSend === plan.allowed, 'Only an admitted local send clears its input.');
/** This is a local IO plan, not execution. The owned socket and canonical input protocol remain the writer. */
export function terminalRunPlan(state: TerminalStreamState, raw: unknown) {
  const request = TerminalRunRequestSchema.parse(raw);
  if (state.sessionId !== request.sessionId) throw refuse('The command input belongs to another terminal.');
  const allowed = !!state.session && state.session.status === 'open' && state.connected && !state.terminalClosed && request.transportOpen && !!request.text.trim();
  let frame: z.infer<typeof RunFrameSchema> | null = null;
  if (allowed) {
    let binary = ''; for (const byte of new TextEncoder().encode(`${request.text}\r`)) binary += String.fromCharCode(byte);
    frame = { schema: 'terminal-frame-v1', type: 'input', data: btoa(binary) };
  }
  return TerminalRunPlanSchema.parse({ schema: 'terminal-run-plan-v1', sessionId: request.sessionId, allowed, clearAfterSend: allowed, frame });
}
export function terminalOwnerClosed(current: TerminalStreamState, rawReceipt: unknown): TerminalStreamTransition {
  const receipt = TerminalActionReceiptSchema.parse(rawReceipt);
  if (receipt.operation !== 'close' || receipt.sessionId !== current.sessionId) throw refuse('The closed terminal receipt belongs to another resource.');
  const status = terminalActionsPolicy().ownerClosedLabel;
  return { schema: 'terminal-stream-transition-v1', state: { ...current, connected: false, terminalClosed: true, status,
    session: current.session ? { ...current.session, status: 'closed', closedReason: status } : null },
    effects: [{ schema: 'terminal-stream-effect-v1', type: 'heartbeat-stop' }, { schema: 'terminal-stream-effect-v1', type: 'cancel-retry' }] };
}
