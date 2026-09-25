import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConversationReadSchema, EmptySchema, IdSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { publicConversationData, streamConversation } from './conversation-events.js';
import { json, requestBody } from './http.js';

const reads = new Set(['', 'changes', 'file', 'events', 'read']);
const writes = new Set(['messages', 'manual', 'resume', 'retry-external', 'choices', 'cancel', 'approve-plan', 'settle', 'correct', 'retry-redo', 'adopt-changes', 'rename', 'finish-outside']);
export type ConversationRoute = { id: string; operation: string; stretch?: number };

/** The same closed route table serves local and owner-relayed requests. */
export function conversationRoute(path: string, method: string): ConversationRoute | null {
  const match = path.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)(?:\/([a-z-]+)(?:\/([1-9]\d*))?)?$/);
  if (!match) return null;
  const operation = match[2] ?? ''; const stretch = match[3] ? Number(match[3]) : undefined;
  if (!reads.has(operation) && !writes.has(operation) || (operation === 'changes') !== (stretch !== undefined) || stretch !== undefined && !Number.isSafeInteger(stretch)) return null;
  if (method !== (reads.has(operation) ? 'GET' : 'POST')) throw Object.assign(new Error('This conversation operation does not support that method.'), { status: 405 });
  return { id: IdSchema.parse(match[1]), operation, ...(stretch === undefined ? {} : { stretch }) };
}

export async function handleConversation(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, route: ConversationRoute, authenticated: () => boolean | Promise<boolean>): Promise<void> {
  const { id, operation } = route;
  const send = (value: unknown, status = 200) => json(response, app.redactor.document(value), status);
  await app.conversations.ready;
  if (!operation) { send(await app.conversations.view(id)); return; }
  if (operation === 'changes') { send(await app.conversations.changes(id, route.stretch!)); return; }
  if (operation === 'file') {
    send(await app.conversations.file(id, { schema: 'conversation-file-request-v1', ref: url.searchParams.get('ref') ?? '', stretch: Number(url.searchParams.get('stretch')), source: url.searchParams.get('source') ?? 'step' })); return;
  }
  if (operation === 'events') { streamConversation(app.conversations.ledger(id), request, response, url, authenticated); return; }
  if (operation === 'read') {
    const pointer = url.searchParams.get('pointer') ?? '';
    send(ConversationReadSchema.parse({ schema: 'conversation-read-v1', pointer, content: publicConversationData(app.conversations.ledger(id).read(pointer)) })); return;
  }
  const input = await requestBody(request);
  if (operation === 'rename') { send(await app.conversations.rename(id, input)); return; }
  if (operation === 'finish-outside') { send(await app.conversations.finishOutside(id, input)); return; }
  if (operation === 'messages') { send(await app.conversations.message(id, input)); return; }
  if (operation === 'manual') { send(await app.conversations.manual(id, input), 202); return; }
  if (operation === 'retry-redo') { send(await app.conversations.retryRedo(id, input), 202); return; }
  if (operation === 'adopt-changes') { send(await app.conversations.adoptChanges(id, input), 202); return; }
  if (operation === 'correct') { send(await app.conversations.correct(id, input), 202); return; }
  if (operation === 'settle') { send(await app.conversations.settle(id, input), 202); return; }
  if (operation === 'approve-plan') { send(await app.conversations.approvePlan(id, input)); return; }
  if (operation === 'resume') { send(await app.conversations.resumeDecision(id, input), 202); return; }
  if (operation === 'retry-external') { send(await app.conversations.retryExternalActivity(id, input), 202); return; }
  if (operation === 'choices') { send(await app.conversations.composerChoice(id, input)); return; }
  if (operation === 'cancel') { EmptySchema.parse(input); send(await app.conversations.cancel(id)); return; }
  throw Object.assign(new Error('Conversation operation not found.'), { status: 404 });
}
