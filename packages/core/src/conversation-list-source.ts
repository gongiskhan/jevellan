import { z } from 'zod';
import { ConversationIndexSchema, ProjectSchema, IdSchema, type Conversation } from './schemas.js';

export const CONVERSATION_LIST_POLL_MS = 5000;
export const CONVERSATION_UPDATED_EVENT = 'jevellan-conversation-updated';
export const ConversationListReadRequestSchema = z.strictObject({ schema: z.literal('conversation-list-read-request-v1') });
export const ConversationListReadPolicySchema = z.strictObject({ schema: z.literal('conversation-list-read-policy-v1'), pollMs: z.literal(CONVERSATION_LIST_POLL_MS), updatedEvent: z.literal(CONVERSATION_UPDATED_EVENT) });
export const ConversationListSourceSchema = z.strictObject({ schema: z.literal('conversation-list-source-v1'), deviceId: IdSchema,
  conversations: z.array(ConversationIndexSchema), projects: z.array(ProjectSchema.pick({ id: true, name: true })), readPolicy: ConversationListReadPolicySchema });
export type ConversationListSource = z.infer<typeof ConversationListSourceSchema>;

/** The existing owner list refresh skips notifications while its current read is in flight. */
export function conversationListRefresh<T>(read: (signal: AbortSignal) => Promise<T>, receive: (value: T) => void, failed: (error: unknown) => void) {
  const controller = new AbortController(); let running = false;
  const request = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try { const value = await read(controller.signal); if (!controller.signal.aborted) receive(value); }
    catch (error) { if (!controller.signal.aborted) failed(error); }
    finally { running = false; }
  };
  return { request, stop: () => controller.abort() };
}

export function conversationListUpdateKey(conversation?: Pick<Conversation, 'id' | 'state' | 'title'>): string | null {
  return conversation ? JSON.stringify([conversation.id, conversation.state, conversation.title]) : null;
}
