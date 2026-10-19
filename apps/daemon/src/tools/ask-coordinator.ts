import { setTimeout as delay } from 'node:timers/promises';
import { HubUnavailable } from '@jevellan/core';
import type { OwnerContext, OwnerHandler } from '../owner-tools.js';
import { clientId } from './common.js';

const REPLY_LIMIT = 600;

/** The coordinator's reply to one owner message, polled from the project journal like `jevellan project send --wait`. */
async function reply(context: OwnerContext, clientMessageId: string, waitSeconds: number): Promise<string | null> {
  const { app, project } = context; const deadline = Date.now() + waitSeconds * 1000;
  while (waitSeconds > 0) {
    try {
      const query = { schema: 'project-journal-request-v1' as const, projectId: project.id, operation: 'coordinator-reply' as const, clientMessageId };
      const result = app.member ? await app.member.projectJournal(query) : await app.projectWork.journal!.request(query, app.device.deviceId);
      if (result.operation === 'coordinator-reply' && result.reply?.reply) return result.reply.reply;
    } catch (error) { if (!(error instanceof HubUnavailable)) throw error; }
    const left = deadline - Date.now(); if (left <= 0) break;
    await delay(Math.min(left, 1000));
  }
  return null;
}

/**
 * `ask_coordinator` (bridge specification). Tell uses the owner-message path with `via: bridge`, so the coordinator sees it as the
 * owner's message and accounts for it in its handoff. Ask is delivered with the prefix "Answer only, do not act:" (the specification's
 * fallback, chosen for every runtime in this version; see the run log) and waits for the reply; a later reply is pushed.
 */
export const askCoordinator: OwnerHandler = async (context) => {
  const { app, tools, project, args } = context; const mode = context.action as 'ask' | 'tell'; const text = String(args.text);
  const view = await app.projectWork.view(project.id);
  const waitSeconds = typeof args.wait_seconds === 'number' ? args.wait_seconds : mode === 'ask' ? 90 : 0;
  if (mode === 'ask' && view.coordinator.state === 'none' && !view.coordinator.session) return { text: 'The coordinator has not started yet.' };
  const clientMessageId = clientId(mode === 'ask' ? 'owner_ask' : 'owner_tell');
  const body = mode === 'ask' ? `[Jevellan] The owner asks. Answer only, do not act: do not start, change or stop anything. Question: ${text}` : text;
  await app.projectWork.sendOwnerMessage(project.id, { schema: 'project-send-request-v1', clientMessageId, text: body, via: 'bridge', waitSeconds: 0 });
  tools.awaitCoordinatorReply(project.id, clientMessageId, mode === 'ask' ? { question: text } : {});
  if (mode === 'tell') {
    const state = view.coordinator.state === 'running' ? 'working' : view.coordinator.state === 'none' ? 'starting' : view.coordinator.state;
    return { text: `Sent to the coordinator. It sees it at its next turn (it is ${state} now).` };
  }
  const answer = await reply(context, clientMessageId, waitSeconds);
  if (answer === null) return { text: 'The coordinator is still working on the answer. It will arrive as a push.' };
  tools.coordinatorReplyDelivered(clientMessageId);
  return { text: `Coordinator: ${answer.length > 8000 ? `${answer.slice(0, 7997)}...` : answer}` };
};
export { reply as coordinatorReply, REPLY_LIMIT };
