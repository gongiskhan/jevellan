import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {TaskActionRequestSchema,TaskUpdateRequestSchema,TaskPositionSchema,TaskStateSchema,TaskTypeSchema} from './project-loop-schemas.js';

export const ProjectTaskContextSchema=z.strictObject({schema:z.literal('project-task-context-v1'),projectId:IdSchema,taskId:IdSchema,revision:z.number().int().nonnegative(),title:z.string().max(120),state:TaskStateSchema,now:z.boolean(),held:z.boolean().default(false),threadId:IdSchema.nullable(),dispatching:z.boolean().default(false)});
export const ProjectTaskEditFieldsSchema=z.strictObject({title:z.string().max(20000),brief:z.string().max(200000),type:TaskTypeSchema,goalId:z.string().max(128)});
export const ProjectTaskIntentBodySchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('action'),action:TaskActionRequestSchema.shape.action}),
 z.strictObject({kind:z.literal('move'),position:TaskPositionSchema}),
 z.strictObject({kind:z.literal('edit'),fields:ProjectTaskEditFieldsSchema}),
]);
export const ProjectTaskIntentRequestSchema=z.strictObject({schema:z.literal('project-task-intent-v1'),context:ProjectTaskContextSchema,intent:ProjectTaskIntentBodySchema});
export const ProjectTaskCommandSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('project-task-command-v1'),projectId:IdSchema,taskId:IdSchema,operation:z.literal('action'),body:TaskActionRequestSchema}),
 z.strictObject({schema:z.literal('project-task-command-v1'),projectId:IdSchema,taskId:IdSchema,operation:z.literal('update'),body:TaskUpdateRequestSchema}),
]);
export const ProjectTaskDraftSchema=z.strictObject({schema:z.literal('project-task-draft-v1'),command:ProjectTaskCommandSchema});
export const ProjectTaskQueueRequestSchema=z.strictObject({schema:z.literal('project-task-queue-request-v1'),scope:z.enum(['all','proposed']).default('all'),grouped:z.boolean().default(false),grouping:z.enum(['order','goals']).default('order')});
const link=z.strictObject({label:z.string(),href:z.string().startsWith('/projects/')});
const action=z.strictObject({id:z.enum(['approve','reject','now','edit','cancel','top','bottom','earlier','later']),kind:z.enum(['command','edit','confirm']),label:z.string(),primary:z.boolean(),enabled:z.boolean(),busyDisabled:z.boolean(),ariaLabel:z.string().nullable(),intent:ProjectTaskIntentBodySchema.nullable(),confirmation:z.strictObject({title:z.string(),action:z.string(),consequence:z.string(),danger:z.boolean()}).nullable()});
export const ProjectTaskQueueInteractionSchema=z.strictObject({schema:z.literal('project-task-queue-interaction-v1'),projectId:IdSchema,request:ProjectTaskQueueRequestSchema,order:z.array(IdSchema),groups:z.array(z.strictObject({label:z.string(),taskIds:z.array(IdSchema)})),showGrouping:z.boolean(),groupChoices:z.array(z.strictObject({value:z.enum(['order','goals']),label:z.string(),selected:z.boolean()})),emptyText:z.string(),groupEmptyText:z.string(),rows:z.array(z.strictObject({taskId:IdSchema,context:ProjectTaskContextSchema,dragEligible:z.boolean(),taskLink:link,threadLink:link.nullable(),needsLine:z.string().nullable(),endNote:z.string().nullable(),actions:z.array(action)}))});
export const ProjectTaskEditViewSchema=z.strictObject({schema:z.literal('project-task-edit-view-v1'),projectId:IdSchema,taskId:IdSchema,context:ProjectTaskContextSchema,defaults:ProjectTaskEditFieldsSchema,types:z.array(TaskTypeSchema),goals:z.array(z.strictObject({id:z.string(),label:z.string()})),limits:z.strictObject({title:z.number().int().positive(),brief:z.number().int().positive()}),labels:z.strictObject({title:z.string(),titleField:z.string(),briefField:z.string(),typeField:z.string(),goalField:z.string(),save:z.string(),cancel:z.string()})});
export type ProjectTaskContext=z.infer<typeof ProjectTaskContextSchema>;
export type ProjectTaskQueueInteraction=z.infer<typeof ProjectTaskQueueInteractionSchema>;
