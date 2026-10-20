import { z } from 'zod';
import { GoalDueSchema } from './owner-tool-schemas.js';
import { IdSchema } from './schemas.js';
import { GoalUpdateRequestSchema } from './project-goal-schemas.js';

const confirmation = z.strictObject({ title: z.string(), action: z.string(), consequence: z.string() });
export const ProjectGoalActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('edit'), name: z.literal('edit'), label: z.string(), path: z.string() }),
  z.strictObject({ kind: z.literal('update'), name: z.enum(['pause', 'resume', 'done']), label: z.string(), enabled: z.boolean(), refusal: z.string().nullable(),
    request: z.strictObject({ path: z.string(), body: GoalUpdateRequestSchema }), confirm: confirmation.nullable() }),
]);
export type ProjectGoalAction = z.infer<typeof ProjectGoalActionSchema>;
const group = z.strictObject({ label: z.string(), taskIds: z.array(IdSchema) });
const scope = z.strictObject({ order: z.array(IdSchema), groups: z.array(group) });
export const ProjectTaskQueueViewSchema = z.strictObject({ schema: z.literal('project-task-queue-view-v1'),
  scopes: z.strictObject({ all: scope, proposed: scope }),
  rows: z.array(z.strictObject({ taskId: IdSchema, stateLabel: z.string(), meta: z.string(), goalNotice: z.string().nullable(), threadLine: z.string().nullable(), waitingLine: z.string().nullable() })),
});
export type ProjectTaskQueueView = z.infer<typeof ProjectTaskQueueViewSchema>;
export const ProjectGoalViewsSchema = z.strictObject({ schema: z.literal('project-goal-views-v1'), projectId: IdSchema,
  createEditorPath: z.string(), emptyText: z.string(), queue: ProjectTaskQueueViewSchema,
  rows: z.array(z.strictObject({ goalId: IdSchema, name: z.string(), motivation: z.string(), health: z.string(), stateLabel: z.string(), autonomyLabel: z.string(),
    due: z.array(GoalDueSchema), dueLine: z.string().nullable(), countsLine: z.string(), capsLine: z.string(), notice: z.string().nullable(), actions: z.array(ProjectGoalActionSchema) })),
});
export type ProjectGoalViews = z.infer<typeof ProjectGoalViewsSchema>;
const rawNumber = z.string().trim().min(1).max(40);
export const GoalEditorFieldsSchema = z.strictObject({ name: z.string().max(80), motivation: z.string().max(4000), health: z.string().max(1000),
  autonomy: z.string().min(1).max(40), state: z.string().min(1).max(40), dailyRefillCap: rawNumber, openPrCap: rawNumber });
const create = z.strictObject({ schema: z.literal('goal-editor-create-request-v1'), clientRequestId: IdSchema });
const update = z.strictObject({ schema: z.literal('goal-editor-update-request-v1'), expectedRevision: z.number().int().positive() });
export const GoalEditorSaveRequestSchema = z.discriminatedUnion('schema', [create.extend({ fields: GoalEditorFieldsSchema }), update.extend({ fields: GoalEditorFieldsSchema })]);
const choice = z.strictObject({ value: z.string(), label: z.string() });
const numberLimits = z.strictObject({ min: z.number(), max: z.number() });
const textLimits = z.strictObject({ maxLength: z.number().int().positive() });
export const ProjectGoalEditorSchema = z.strictObject({ schema: z.literal('project-goal-editor-v1'), projectId: IdSchema, goalId: IdSchema.nullable(), title: z.string(),
  defaults: GoalEditorFieldsSchema, choices: z.strictObject({ states: z.array(choice), autonomy: z.array(choice) }),
  constraints: z.strictObject({ name: textLimits, motivation: textLimits, health: textLimits, dailyRefillCap: numberLimits, openPrCap: numberLimits }),
  request: z.strictObject({ path: z.string(), base: z.discriminatedUnion('schema', [create, update]) }),
});
export type ProjectGoalEditor = z.infer<typeof ProjectGoalEditorSchema>;
