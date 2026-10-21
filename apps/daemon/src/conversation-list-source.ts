import { ConversationListSourceSchema, CONVERSATION_LIST_POLL_MS, CONVERSATION_UPDATED_EVENT } from '@jevellan/core';
import type { Application } from './application.js';

/** The same owner/project readers as the legacy sidebar, combined without changing their authority. */
export async function conversationListSource(app: Application) {
  await app.conversations.ready;
  const [list, projects] = await Promise.all([app.conversations.list(), app.conversations.projects()]);
  return ConversationListSourceSchema.parse(app.redactor.document({ schema: 'conversation-list-source-v1', deviceId: app.device.deviceId,
    conversations: list.conversations, projects: projects.projects.map(({ project }) => ({ id: project.id, name: project.name })),
    readPolicy: { schema: 'conversation-list-read-policy-v1', pollMs: CONVERSATION_LIST_POLL_MS, updatedEvent: CONVERSATION_UPDATED_EVENT } }));
}
