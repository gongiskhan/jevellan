import { z } from 'zod';
import { ProjectPageRequestSchema, ProjectPageViewSchema, type ProjectPageRequest } from './project-page-schemas.js';
import { ConversationPublicSchema } from './conversation-schemas.js';

export const STATUS_REFRESH_WINDOW_MS = 40;

export const ProjectStatusStreamRequestSchema = z.strictObject({ schema: z.literal('project-status-stream-request-v1'), page: ProjectPageRequestSchema });
export const ConversationStatusStreamRequestSchema = z.strictObject({ schema: z.literal('conversation-status-stream-request-v1') });
export const ProjectStatusEventSchema = z.strictObject({ schema: z.literal('project-status-event-v1'), request: ProjectPageRequestSchema, view: ProjectPageViewSchema });
export const ConversationStatusEventSchema = z.strictObject({ schema: z.literal('conversation-status-event-v1'), view: ConversationPublicSchema });

/** A pushed project snapshot is useful only for the current local viewer context. */
export function matchingProjectStatusView(frame: { request: ProjectPageRequest }, current: ProjectPageRequest): boolean {
  const prior = frame.request;
  return prior.resolvedDays === current.resolvedDays && prior.timeZone === current.timeZone && prior.locale === current.locale
    && (prior.ackKnown === undefined || current.ackKnown === undefined ? prior.ackKnown === current.ackKnown
      : prior.ackKnown.length === current.ackKnown.length && prior.ackKnown.every((id, index) => id === current.ackKnown![index]));
}
