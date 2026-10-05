import { z } from 'zod';
import {
  DecisionAnswerSchema, FileReservationSchema, PlacementOverrideSchema, ProjectCoordinatorSchema, ProjectCoordinatorStatusSchema, ProjectDecisionSchema, ProjectEnvelopeSchema, ProjectMailSchema,
  ProjectNotebookSchema, ProjectWorkSettingsSchema, ThreadIndexSchema,
} from './project-schemas.js';
import { DevicePresenceSchema } from './mesh-schemas.js';
import { IdSchema, TimestampSchema } from './schemas.js';

// Members reach project hub state through POST /hub/mesh/projects/<collection> with operation-discriminated bodies (D7).
// The main isolation phase adds the held checkouts read (6).
export const ProjectHubCollectionSchema = z.enum(['settings', 'coordinators', 'threads', 'decisions', 'notebooks', 'overrides',
  'envelopes', 'work', 'mail', 'reservations', 'checkouts']);
export type ProjectHubCollection = z.infer<typeof ProjectHubCollectionSchema>;
export const PROJECT_HUB_PAGE = 100;
/** A pending-envelope page also stops near this many serialized bytes (at least one envelope), under the member's 2 MiB reply cap (D260). */
export const ENVELOPE_PAGE_BYTES = 1024 * 1024;
/** An inbox page stops near this many serialized bytes too (at least one mail): 100 mails of 8,000 characters can pass the reply cap (D285). */
export const MAIL_PAGE_BYTES = 1024 * 1024;

const count = z.number().int().nonnegative();
/**
 * One project's row of the Projects list as the hub computes it (D267): the sidebar counts and where the coordinator lives, with
 * that device's presence from the roster and the state it last published (only when the publisher is the assigned device).
 */
export const ProjectWorkSummarySchema = z.strictObject({ schema: z.literal('project-work-summary-v1'), projectId: IdSchema, name: z.string().min(1),
  waiting: count, running: count, inReview: count,
  coordinator: z.strictObject({ deviceId: IdSchema, device: z.strictObject({ name: z.string().min(1), status: DevicePresenceSchema, revoked: z.boolean() }).nullable(),
    state: z.enum(['idle', 'running', 'unavailable']).nullable() }).nullable() });
export type ProjectWorkSummary = z.infer<typeof ProjectWorkSummarySchema>;
/** A path reservation as a thread asks for it (brief 5.11, 7.2; D285): the hub adds the caller's device, its own clock's times and the revision. */
export const ReservationRequestSchema = z.strictObject({ id: IdSchema, projectId: IdSchema, threadId: IdSchema, paths: FileReservationSchema.shape.paths,
  reason: FileReservationSchema.shape.reason, minutes: z.number().int().min(1).max(120) });
export type ReservationRequest = z.infer<typeof ReservationRequestSchema>;
/** Another thread's active reservation that overlaps a request: its overlapping paths only, and its title (null when the hub has no index for it). */
export const ReservationConflictSchema = z.strictObject({ threadId: IdSchema, threadTitle: z.string().min(1).max(120).nullable(), paths: FileReservationSchema.shape.paths,
  expiresAt: TimestampSchema });
export type ReservationConflict = z.infer<typeof ReservationConflictSchema>;
/**
 * A device whose project checkout main threads cannot take (brief 10, D64, D65, D288): the held checkout claim of a conversation or
 * thread, else the oldest main thread of the project there that has not ended. One per device; `ownerId` is the conversation or thread id.
 */
export const HeldCheckoutSchema = z.strictObject({ deviceId: IdSchema, ownerId: IdSchema, title: z.string().min(1).max(200) });
export type HeldCheckout = z.infer<typeof HeldCheckoutSchema>;

const request = { schema: z.literal('project-hub-request-v1') };
const project = { projectId: IdSchema };
const page = { projectId: IdSchema, after: IdSchema.optional() };
const expectedRevision = z.number().int().nonnegative();
export const ProjectHubRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...request, operation: z.literal('settings-get'), ...project }),
  z.strictObject({ ...request, operation: z.literal('settings-put'), settings: ProjectWorkSettingsSchema, expectedRevision, clientRequestId: IdSchema.optional() }),
  z.strictObject({ ...request, operation: z.literal('coordinator-get'), ...project }),
  z.strictObject({ ...request, operation: z.literal('coordinator-assign'), ...project, deviceId: IdSchema, expectedRevision }),
  z.strictObject({ ...request, operation: z.literal('coordinator-status-get'), ...project }),
  z.strictObject({ ...request, operation: z.literal('coordinator-status-put'), status: ProjectCoordinatorStatusSchema }),
  z.strictObject({ ...request, operation: z.literal('threads-list'), ...page }),
  z.strictObject({ ...request, operation: z.literal('thread-get'), threadId: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('thread-publish'), index: ThreadIndexSchema, eventId: z.number().int().positive() }),
  z.strictObject({ ...request, operation: z.literal('decisions-list'), ...page }),
  z.strictObject({ ...request, operation: z.literal('decision-get'), id: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('decision-create'), decision: ProjectDecisionSchema }),
  z.strictObject({ ...request, operation: z.literal('decision-withdraw'), id: IdSchema, at: TimestampSchema }),
  z.strictObject({ ...request, operation: z.literal('decision-answer'), id: IdSchema, answer: DecisionAnswerSchema, at: TimestampSchema, clientRequestId: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('notebook-get'), ...project }),
  z.strictObject({ ...request, operation: z.literal('notebook-put'), notebook: ProjectNotebookSchema, expectedRevision }),
  z.strictObject({ ...request, operation: z.literal('override-add'), override: PlacementOverrideSchema }),
  z.strictObject({ ...request, operation: z.literal('overrides-recent'), ...project, limit: z.number().int().min(1).max(PROJECT_HUB_PAGE) }),
  // Relay (phase 5, D40): the source puts, the target reads its pending envelopes and acknowledges each one, which deletes it (D90).
  z.strictObject({ ...request, operation: z.literal('envelope-put'), envelope: ProjectEnvelopeSchema }),
  z.strictObject({ ...request, operation: z.literal('envelopes-pending'), targetDeviceId: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('envelope-ack'), id: IdSchema }),
  // The Projects list in one request (phase 5, D267): every project's summary, pages of 100 by project id.
  z.strictObject({ ...request, operation: z.literal('work-summaries'), after: IdSchema.optional() }),
  // Mail and reservations between main threads (phase 6, brief 5.11; D285). Reading the inbox marks nothing: the reader marks what it
  // received, so a lost reply repeats mail instead of losing it. Reservations conflict-check and insert in one hub transaction.
  z.strictObject({ ...request, operation: z.literal('mail-send'), mail: ProjectMailSchema }),
  z.strictObject({ ...request, operation: z.literal('mail-inbox'), ...project, threadId: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('mail-read'), ...project, threadId: IdSchema, ids: z.array(IdSchema).min(1).max(PROJECT_HUB_PAGE) }),
  z.strictObject({ ...request, operation: z.literal('reserve'), reservation: ReservationRequestSchema }),
  z.strictObject({ ...request, operation: z.literal('release'), ...project, threadId: IdSchema, id: IdSchema.optional() }),
  z.strictObject({ ...request, operation: z.literal('reservations-list'), ...page }),
  // Where main threads cannot work (phase 6, D288): derived on the hub from checkout claims and thread indexes, one entry per device.
  z.strictObject({ ...request, operation: z.literal('checkouts-held'), ...project }),
]);
export type ProjectHubRequest = z.infer<typeof ProjectHubRequestSchema>;
export type ProjectHubOperation = ProjectHubRequest['operation'];
const collections = {
  'settings-get': 'settings', 'settings-put': 'settings',
  'coordinator-get': 'coordinators', 'coordinator-assign': 'coordinators', 'coordinator-status-get': 'coordinators', 'coordinator-status-put': 'coordinators',
  'threads-list': 'threads', 'thread-get': 'threads', 'thread-publish': 'threads',
  'decisions-list': 'decisions', 'decision-get': 'decisions', 'decision-create': 'decisions', 'decision-withdraw': 'decisions', 'decision-answer': 'decisions',
  'notebook-get': 'notebooks', 'notebook-put': 'notebooks',
  'override-add': 'overrides', 'overrides-recent': 'overrides',
  'envelope-put': 'envelopes', 'envelopes-pending': 'envelopes', 'envelope-ack': 'envelopes',
  'work-summaries': 'work',
  'mail-send': 'mail', 'mail-inbox': 'mail', 'mail-read': 'mail',
  'reserve': 'reservations', 'release': 'reservations', 'reservations-list': 'reservations',
  'checkouts-held': 'checkouts',
} as const satisfies Record<ProjectHubOperation, ProjectHubCollection>;
/** The one collection route that accepts an operation. */
export function collectionOf(operation: ProjectHubOperation): ProjectHubCollection { return collections[operation]; }
// Every operation is classified, so an operation added by a later phase cannot skip the lifecycle gate unnoticed.
const access = {
  'settings-get': 'read', 'settings-put': 'write',
  'coordinator-get': 'read', 'coordinator-assign': 'write', 'coordinator-status-get': 'read', 'coordinator-status-put': 'write',
  'threads-list': 'read', 'thread-get': 'read', 'thread-publish': 'write',
  'decisions-list': 'read', 'decision-get': 'read', 'decision-create': 'write', 'decision-withdraw': 'write', 'decision-answer': 'write',
  'notebook-get': 'read', 'notebook-put': 'write',
  'override-add': 'write', 'overrides-recent': 'read',
  'envelope-put': 'write', 'envelopes-pending': 'read', 'envelope-ack': 'write',
  'work-summaries': 'read',
  'mail-send': 'write', 'mail-inbox': 'read', 'mail-read': 'write',
  'reserve': 'write', 'release': 'write', 'reservations-list': 'read',
  'checkouts-held': 'read',
} as const satisfies Record<ProjectHubOperation, 'read' | 'write'>;
/** Reads change no hub state, so the hub admits them like GET requests, outside the lifecycle gate (D247). */
export function isProjectHubRead(operation: ProjectHubOperation): boolean { return access[operation] === 'read'; }

/** A hub row as returned to members: the embedded document revision must equal the row revision (D3). */
function stored<T extends z.ZodType<{ revision: number }>>(document: T) {
  return z.strictObject({ revision: z.number().int().positive(), document })
    .refine((value) => { const row = value as { revision: number; document: { revision: number } }; return row.document.revision === row.revision; }, 'The hub returned a record whose revision does not match its document.');
}
const result = { schema: z.literal('project-hub-result-v1') };
const records = <T extends z.ZodType>(document: T) => ({ records: z.array(document).max(PROJECT_HUB_PAGE), next: IdSchema.nullable() });
export const ProjectHubResultSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...result, operation: z.literal('settings-get'), record: stored(ProjectWorkSettingsSchema).nullable() }),
  z.strictObject({ ...result, operation: z.literal('settings-put'), record: stored(ProjectWorkSettingsSchema) }),
  z.strictObject({ ...result, operation: z.literal('coordinator-get'), record: stored(ProjectCoordinatorSchema).nullable() }),
  z.strictObject({ ...result, operation: z.literal('coordinator-assign'), record: stored(ProjectCoordinatorSchema) }),
  z.strictObject({ ...result, operation: z.literal('coordinator-status-get'), record: stored(ProjectCoordinatorStatusSchema).nullable() }),
  z.strictObject({ ...result, operation: z.literal('coordinator-status-put'), record: stored(ProjectCoordinatorStatusSchema) }),
  z.strictObject({ ...result, operation: z.literal('threads-list'), ...records(ThreadIndexSchema) }),
  z.strictObject({ ...result, operation: z.literal('thread-get'), record: stored(ThreadIndexSchema).nullable() }),
  z.strictObject({ ...result, operation: z.literal('thread-publish'), threadId: IdSchema, eventId: z.number().int().positive() }),
  z.strictObject({ ...result, operation: z.literal('decisions-list'), ...records(ProjectDecisionSchema) }),
  z.strictObject({ ...result, operation: z.literal('decision-get'), record: stored(ProjectDecisionSchema).nullable() }),
  z.strictObject({ ...result, operation: z.literal('decision-create'), record: stored(ProjectDecisionSchema) }),
  z.strictObject({ ...result, operation: z.literal('decision-withdraw'), record: stored(ProjectDecisionSchema) }),
  z.strictObject({ ...result, operation: z.literal('decision-answer'), record: stored(ProjectDecisionSchema), repeated: z.boolean() }),
  z.strictObject({ ...result, operation: z.literal('notebook-get'), record: stored(ProjectNotebookSchema).nullable() }),
  z.strictObject({ ...result, operation: z.literal('notebook-put'), record: stored(ProjectNotebookSchema) }),
  // Overrides carry no revision: the collection is append-only (D252).
  z.strictObject({ ...result, operation: z.literal('override-add'), override: PlacementOverrideSchema }),
  z.strictObject({ ...result, operation: z.literal('overrides-recent'), records: z.array(PlacementOverrideSchema).max(PROJECT_HUB_PAGE) }),
  // `stored: false` answers an identical retry; `more` says another page is waiting; an unknown id acknowledges as `deleted: false`.
  z.strictObject({ ...result, operation: z.literal('envelope-put'), id: IdSchema, stored: z.boolean() }),
  z.strictObject({ ...result, operation: z.literal('envelopes-pending'), records: z.array(ProjectEnvelopeSchema).max(PROJECT_HUB_PAGE), more: z.boolean() }),
  z.strictObject({ ...result, operation: z.literal('envelope-ack'), id: IdSchema, deleted: z.boolean() }),
  z.strictObject({ ...result, operation: z.literal('work-summaries'), records: z.array(ProjectWorkSummarySchema).max(PROJECT_HUB_PAGE), next: IdSchema.nullable() }),
  // An inbox page is the oldest unread mail (`more` when other mail waits); a reservation is granted (`reservation`) or refused with its conflicts.
  z.strictObject({ ...result, operation: z.literal('mail-send'), record: stored(ProjectMailSchema) }),
  z.strictObject({ ...result, operation: z.literal('mail-inbox'), records: z.array(ProjectMailSchema).max(PROJECT_HUB_PAGE), more: z.boolean() }),
  z.strictObject({ ...result, operation: z.literal('mail-read'), read: count }),
  z.strictObject({ ...result, operation: z.literal('reserve'), reservation: stored(FileReservationSchema).nullable(), conflicts: z.array(ReservationConflictSchema).max(PROJECT_HUB_PAGE) }),
  z.strictObject({ ...result, operation: z.literal('release'), released: count }),
  z.strictObject({ ...result, operation: z.literal('reservations-list'), ...records(FileReservationSchema) }),
  z.strictObject({ ...result, operation: z.literal('checkouts-held'), records: z.array(HeldCheckoutSchema).max(PROJECT_HUB_PAGE) }),
]);
export type ProjectHubResult = z.infer<typeof ProjectHubResultSchema>;
export type ProjectHubResultOf<O extends ProjectHubOperation> = Extract<ProjectHubResult, { operation: O }>;
