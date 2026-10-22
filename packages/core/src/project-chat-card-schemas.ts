import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ProjectWorkTaskSchema} from './project-loop-schemas.js';
import {ThreadIndexSchema} from './project-schemas.js';
import {ProjectWorkCardSchema} from './project-card-schemas.js';
import {ProjectChatItemSchema} from './project-chat-schemas.js';
import {ProjectTaskCommandSchema} from './project-task-interaction-schemas.js';

export const ProjectChatCardPolicySchema=z.strictObject({schema:z.literal('project-chat-card-policy-v1'),labels:z.strictObject({start:z.string(),dismiss:z.string(),loading:z.string(),message:z.string()})});
export const projectChatCardPolicy=Object.freeze(ProjectChatCardPolicySchema.parse({schema:'project-chat-card-policy-v1',labels:{start:'Start',dismiss:'Dismiss',loading:'Loading task…',message:'Sent a message'}}));
const contextFields={projectId:IdSchema,tasks:z.array(ProjectWorkTaskSchema),threads:z.array(ThreadIndexSchema),cards:z.array(ProjectWorkCardSchema)};
const scope=(value:{projectId:string;tasks:readonly{projectId:string}[];threads:readonly{projectId:string}[]},ctx:z.RefinementCtx)=>{if([...value.tasks,...value.threads].some(row=>row.projectId!==value.projectId))ctx.addIssue({code:'custom',message:'These cards belong to another project.'});};
export const ProjectChatCardContextSchema=z.strictObject({schema:z.literal('project-chat-card-context-v1'),...contextFields}).superRefine(scope);
export const ProjectChatCardInteractionSourceSchema=z.strictObject({schema:z.literal('project-chat-card-interaction-source-v1'),...contextFields,item:ProjectChatItemSchema,startAll:z.array(IdSchema)}).superRefine(scope);
const command=ProjectTaskCommandSchema.nullable();
export const ProjectChatCardInteractionSchema=z.strictObject({schema:z.literal('project-chat-card-interaction-v1'),projectId:IdSchema,itemId:z.number().int().positive(),policy:ProjectChatCardPolicySchema,messageText:z.string().nullable(),rows:z.array(z.strictObject({id:IdSchema,task:ProjectWorkTaskSchema.nullable(),thread:ThreadIndexSchema.nullable(),card:ProjectWorkCardSchema.nullable(),start:command,dismiss:command})),batch:z.strictObject({label:z.string(),taskIds:z.array(IdSchema),commands:z.array(ProjectTaskCommandSchema)}).nullable()});
export type ProjectChatCardInteraction=z.infer<typeof ProjectChatCardInteractionSchema>;
export const ProjectChatCardViewRequestSchema=z.strictObject({schema:z.literal('project-chat-card-view-request-v1'),itemId:z.number().int().positive(),deviceId:IdSchema.optional()});
export const ProjectChatCardViewSchema=z.strictObject({schema:z.literal('project-chat-card-view-v1'),projectId:IdSchema,deviceId:IdSchema,request:ProjectChatCardViewRequestSchema.extend({deviceId:IdSchema}),view:ProjectChatCardInteractionSchema}).superRefine((value,ctx)=>{
 if(value.projectId!==value.view.projectId||value.request.itemId!==value.view.itemId||value.request.deviceId!==value.deviceId)ctx.addIssue({code:'custom',message:'This card view belongs to another resource.'});
});
