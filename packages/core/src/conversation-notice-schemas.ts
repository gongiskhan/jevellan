import { z } from 'zod';

export const ConversationNoticeSchema = z.strictObject({ schema: z.literal('conversation-notice-v1'), text: z.string().min(1), kind: z.enum(['info', 'error', 'closing', 'steer']) });
