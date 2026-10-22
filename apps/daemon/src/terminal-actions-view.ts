import { UiAuth } from '@jevellan/mesh';
import { TerminalActionCommandSchema, TerminalActionReceiptSchema, TerminalReadRequestSchema, TerminalCopyRequestSchema, TerminalCopySnippetRequestSchema, TerminalRunRequestSchema,
  terminalActionsView, terminalCopyPlan, terminalCopyView, terminalRunPlan, terminalStreamInitial, terminalStreamEvent } from '@jevellan/core';
import type { Application } from './application.js';
import { readTerminalView } from './terminal-reading-view.js';
import { sendTerminalOutput } from './terminal-output.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
async function withOwner<T>(app: Application, provided: string | undefined, operation: (token: string) => Promise<T>): Promise<T> {
  if (provided) { app.redactor.add(provided); return operation(provided); }
  const auth = app.auth; if (!(auth instanceof UiAuth)) throw refuse('Terminal owner actions must run through the state point.', 409);
  const token = auth.issue(); app.redactor.add(token);
  try { return await operation(token); } finally { auth.logout(token); }
}
export async function readTerminalActions(app: Application, raw: unknown, token?: string) {
  const request = TerminalReadRequestSchema.parse(raw), { snapshot } = await readTerminalView(app, request, token);
  const work = snapshot.session.projectId ? await app.projectWork.view(snapshot.session.projectId) : undefined;
  return terminalActionsView({ schema: 'terminal-actions-source-v1', snapshot, threads: (work?.threads ?? []).map(row => ({ id: row.id, title: row.title, state: row.state })) });
}
export async function readTerminalCopyPlan(app: Application, raw: unknown, token?: string) {
  const request = TerminalCopyRequestSchema.parse(raw);
  await readTerminalView(app, { schema: 'terminal-read-request-v1', sessionId: request.sessionId }, token);
  return terminalCopyPlan(request);
}
export async function readTerminalCopyView(app: Application, raw: unknown, token?: string) {
  const request = TerminalCopySnippetRequestSchema.parse(raw), { snapshot } = await readTerminalView(app, { schema: 'terminal-read-request-v1', sessionId: request.sessionId }, token);
  return terminalCopyView(terminalCopyPlan(request), { schema: 'terminal-copy-source-v1', snapshot });
}
/** Advisory preparation only: this never writes its frame to a socket, PTY or command runner. */
export async function readTerminalRunPlan(app: Application, raw: unknown, token?: string) {
  const request = TerminalRunRequestSchema.parse(raw), { snapshot } = await readTerminalView(app, { schema: 'terminal-read-request-v1', sessionId: request.sessionId }, token);
  let state = terminalStreamInitial(request.sessionId, snapshot.session);
  if (request.transportOpen) state = terminalStreamEvent(state, { schema: 'terminal-stream-event-v1', type: 'opened' }).state;
  return terminalRunPlan(state, request);
}
export async function executeTerminalAction(app: Application, raw: unknown, token?: string) {
  const command = TerminalActionCommandSchema.parse(raw);
  return withOwner(app, token, async owner => {
    const ack = command.operation === 'send' ? await sendTerminalOutput(app, command.sessionId, command.request, owner) : await app.terminals.stop(command.sessionId, owner);
    return TerminalActionReceiptSchema.parse({ schema: 'terminal-action-receipt-v1', operation: command.operation, sessionId: command.sessionId,
      ...(command.operation === 'send' ? { clientMessageId: command.request.clientMessageId } : {}), ack });
  });
}
