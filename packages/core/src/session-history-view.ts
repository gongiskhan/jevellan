import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import type { SessionHistory } from './checkpoint-schemas.js';

export const EARLIER_TRANSCRIPT_UNAVAILABLE = 'The earlier transcript is unavailable.';
export const SessionHistoryViewSchema = z.strictObject({ schema: z.literal('session-history-view-v1'), projectId: IdSchema,
  visible: z.boolean(), summary: z.string(), title: z.string(), entries: z.array(z.strictObject({
    key: z.string().regex(/^[a-f0-9]{64}$/u), href: z.string(), runtime: IdSchema, model: z.string(), at: TimestampSchema })) });
export type SessionHistoryView = z.infer<typeof SessionHistoryViewSchema>;
export function sessionHistoryView(input: { projectId: string; threadId?: string | undefined; entries?: readonly Omit<SessionHistory, 'nativeSessionId'>[] | undefined }): SessionHistoryView {
  const projectId = IdSchema.parse(input.projectId), threadId = input.threadId === undefined ? undefined : IdSchema.parse(input.threadId);
  const entries = input.entries ?? [], path = threadId ? `/api/projects/${projectId}/threads/${threadId}` : `/api/projects/${projectId}/session-transcript`;
  return SessionHistoryViewSchema.parse({ schema: 'session-history-view-v1', projectId, visible: entries.length > 0,
    summary: `Earlier sessions (${entries.length})`, title: 'Earlier session',
    entries: entries.map(entry => ({ key: entry.key, href: `${path}?session=${entry.key}`, runtime: entry.runtime, model: entry.model, at: entry.at })) });
}
