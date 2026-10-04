import { z } from 'zod';
import { DecisionAnswerSchema, PlacementOverrideSchema, ProjectCoordinatorSchema, ProjectCoordinatorStatusSchema, ProjectDecisionSchema, ProjectNotebookSchema, ProjectWorkSettingsSchema, ThreadIndexSchema } from './project-schemas.js';
import { IdSchema, TimestampSchema } from './schemas.js';

// Members reach project hub state through POST /hub/mesh/projects/<collection> with operation-discriminated bodies (D7).
// Later phases add operations: envelopes (5), mail, reservations and checkouts (6).
export const ProjectHubCollectionSchema = z.enum(['settings', 'coordinators', 'threads', 'decisions', 'notebooks', 'overrides',
  'envelopes', 'mail', 'reservations', 'checkouts']);
export type ProjectHubCollection = z.infer<typeof ProjectHubCollectionSchema>;
export const PROJECT_HUB_PAGE = 100;

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
]);
export type ProjectHubResult = z.infer<typeof ProjectHubResultSchema>;
export type ProjectHubResultOf<O extends ProjectHubOperation> = Extract<ProjectHubResult, { operation: O }>;
