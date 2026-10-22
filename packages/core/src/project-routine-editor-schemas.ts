import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ProjectDailySchema } from './project-daily-schemas.js';
import { TaskTypeSchema } from './project-loop-schemas.js';

const selectedId = z.union([z.literal(''), IdSchema]);
export const JobEditorFieldsSchema = z.strictObject({ name: z.string().max(80), goalId: selectedId, enabled: z.boolean(), command: z.string().max(2000),
  intake: z.boolean().optional(), intakeAuthors: z.string().max(4200).optional(),
  needs: z.string().max(264), cwd: z.enum(['checkout', 'workspace']), timeoutMinutes: z.string().max(12), gate: selectedId,
  intervalEnabled: z.boolean(), everyMinutes: z.string().max(12), intervalStart: z.string().max(5), intervalEnd: z.string().max(5) });
export const DailyEditorFieldsSchema = z.strictObject({ name: z.string().max(80), goalId: selectedId, enabled: z.boolean(), order: z.string().max(12),
  days: z.array(ProjectDailySchema.shape.days.unwrap().element).max(7), kind: z.enum(['job', 'session', 'review-since-last', 'memory-dream']),
  jobId: selectedId, title: z.string().max(120), brief: z.string().max(20000), type: TaskTypeSchema, reviewFrom: z.string().max(40) });
export const JobEditorCreateRequestSchema = z.strictObject({ schema: z.literal('job-editor-create-request-v1'), clientRequestId: IdSchema, fields: JobEditorFieldsSchema });
export const JobEditorUpdateRequestSchema = z.strictObject({ schema: z.literal('job-editor-update-request-v1'), expectedRevision: z.number().int().positive(), fields: JobEditorFieldsSchema });
export const DailyEditorCreateRequestSchema = z.strictObject({ schema: z.literal('daily-editor-create-request-v1'), clientRequestId: IdSchema, fields: DailyEditorFieldsSchema });
export const DailyEditorUpdateRequestSchema = z.strictObject({ schema: z.literal('daily-editor-update-request-v1'), expectedRevision: z.number().int().positive(), fields: DailyEditorFieldsSchema });
export const RoutineEditorSaveRequestSchema = z.discriminatedUnion('schema', [JobEditorCreateRequestSchema, JobEditorUpdateRequestSchema, DailyEditorCreateRequestSchema, DailyEditorUpdateRequestSchema]);
export type RoutineEditorSaveRequest = z.infer<typeof RoutineEditorSaveRequestSchema>;
const choice = z.strictObject({ value: z.string(), label: z.string(), disabled: z.boolean(), refusal: z.string().nullable() });
export type RoutineEditorChoice = z.infer<typeof choice>;
const numberLimits = z.strictObject({ min: z.number(), max: z.number() });
export const ProjectJobEditorSchema = z.strictObject({ schema: z.literal('project-job-editor-v1'), projectId: IdSchema, itemId: IdSchema.nullable(), title: z.string(),
  readonly: z.boolean(), notice: z.string().nullable(), defaults: JobEditorFieldsSchema,
  intakePolicy:z.strictObject({label:z.string(),authorsLabel:z.string(),authorsHint:z.string(),authorsMax:z.number().int().positive(),scheduleText:z.string()}).default({label:'Check outside pull requests',authorsLabel:'Contributor GitHub logins',authorsHint:"Leave empty for everyone except your GitHub login. Separate logins with commas.",authorsMax:4200,scheduleText:'Checks every 10 minutes between 08:00 and 23:00 on an eligible work device. Merge, redo and close always wait for your choice.'}),
  constraints: z.strictObject({ nameMax: z.number(), commandMax: z.number(), needsMax: z.number(), timeoutMinutes: numberLimits, everyMinutes: numberLimits }),
  choices: z.strictObject({ goals: z.array(choice), gates: z.array(choice), cwd: z.array(choice.extend({ value: JobEditorFieldsSchema.shape.cwd })) }),
  request: z.strictObject({ path: z.string().startsWith('/api/projects/'), base: z.discriminatedUnion('schema', [JobEditorCreateRequestSchema.omit({ fields: true }), JobEditorUpdateRequestSchema.omit({ fields: true })]) }) });
export type ProjectJobEditor = z.infer<typeof ProjectJobEditorSchema>;
export const ProjectDailyEditorSchema = z.strictObject({ schema: z.literal('project-daily-editor-v1'), projectId: IdSchema, itemId: IdSchema.nullable(), title: z.string(), defaults: DailyEditorFieldsSchema,
  constraints: z.strictObject({ nameMax: z.number(), titleMax: z.number(), briefMax: z.number(), order: numberLimits, reviewFromPattern: z.string(), reviewFromMax: z.number() }),
  choices: z.strictObject({ jobs: z.array(choice), kinds: z.array(choice.extend({ value: DailyEditorFieldsSchema.shape.kind })), types: z.array(choice.extend({ value: TaskTypeSchema })), days: z.array(choice.extend({ value: ProjectDailySchema.shape.days.unwrap().element })),
    goalsByKind: z.strictObject({ job: z.array(choice), session: z.array(choice), 'review-since-last': z.array(choice), 'memory-dream': z.array(choice) }) }),
  notesByKind: z.strictObject({ job: z.string().nullable(), session: z.string().nullable(), 'review-since-last': z.string().nullable(), 'memory-dream': z.string().nullable() }),
  fieldsByKind: z.strictObject({ job: z.strictObject({ job: z.boolean(), session: z.boolean(), review: z.boolean() }), session: z.strictObject({ job: z.boolean(), session: z.boolean(), review: z.boolean() }),
    'review-since-last': z.strictObject({ job: z.boolean(), session: z.boolean(), review: z.boolean() }), 'memory-dream': z.strictObject({ job: z.boolean(), session: z.boolean(), review: z.boolean() }) }),
  request: z.strictObject({ path: z.string().startsWith('/api/projects/'), base: z.discriminatedUnion('schema', [DailyEditorCreateRequestSchema.omit({ fields: true }), DailyEditorUpdateRequestSchema.omit({ fields: true })]) }) });
export type ProjectDailyEditor = z.infer<typeof ProjectDailyEditorSchema>;
