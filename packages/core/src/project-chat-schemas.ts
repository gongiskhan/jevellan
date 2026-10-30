import {z} from 'zod';
import {ProjectStreamPolicySchema} from './project-stream-state.js';
import {IdSchema} from './schemas.js';
import {ProjectLedgerEventSchema,ThreadIndexSchema} from './project-schemas.js';
import {ProjectSettingsChangeSchema} from './project-parity-schemas.js';
const count=z.number().int().nonnegative(),id=ProjectLedgerEventSchema.shape.id;
export const ProjectChatItemSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('owner'),id,text:z.string(),at:z.string(),via:z.string().optional(),heading:z.string(),delivered:z.boolean()}),
 z.strictObject({kind:z.literal('reply'),id,text:z.string(),at:z.string().optional()}),
 z.strictObject({kind:z.literal('routed'),id,turn:z.number().int().positive().optional(),taskIds:z.array(IdSchema).optional(),threadId:IdSchema.optional(),message:z.boolean()}),
 z.strictObject({kind:z.literal('setup'),id,proposalId:IdSchema}),
 z.strictObject({kind:z.literal('settings'),id,change:ProjectSettingsChangeSchema}),
 z.strictObject({kind:z.literal('tool'),id,tool:z.string(),summary:z.string(),ok:z.boolean(),threadId:IdSchema.optional()}),
 z.strictObject({kind:z.literal('event'),id,text:z.string(),detail:z.string().optional(),threadId:IdSchema.optional(),delivered:z.boolean()}),
 z.strictObject({kind:z.literal('notice'),id,text:z.string(),tone:z.enum(['info','error'])}),
]);
export type ProjectChatItem=z.infer<typeof ProjectChatItemSchema>;
export const ProjectChatSourceSchema=z.strictObject({schema:z.literal('project-chat-source-v1'),projectId:IdSchema,deviceId:IdSchema,head:count,threads:z.array(ThreadIndexSchema),events:z.array(ProjectLedgerEventSchema)}).superRefine((source,ctx)=>{
 if(source.threads.some(thread=>thread.projectId!==source.projectId))ctx.addIssue({code:'custom',message:'This chat source includes another project.'});
});
export const ProjectChatViewRequestSchema=z.strictObject({schema:z.literal('project-chat-view-request-v1'),offset:count.default(0),limit:z.number().int().min(1).max(100).default(100),throughEventId:count.optional(),deviceId:IdSchema.optional()});
export const ProjectChatViewSchema=z.strictObject({schema:z.literal('project-chat-view-v1'),projectId:IdSchema,deviceId:IdSchema,head:count,streamPolicy:ProjectStreamPolicySchema.optional(),request:ProjectChatViewRequestSchema.extend({throughEventId:count,deviceId:IdSchema}),total:count,items:z.array(ProjectChatItemSchema).max(100),nextOffset:count.nullable(),hasMore:z.boolean()}).superRefine((view,ctx)=>{
 if(view.request.deviceId!==view.deviceId||view.request.throughEventId>view.head)ctx.addIssue({code:'custom',message:'This chat page belongs to another source.'});
});
export type ProjectChatView=z.infer<typeof ProjectChatViewSchema>;
