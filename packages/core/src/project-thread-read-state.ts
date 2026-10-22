import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ThreadIndexSchema,ThreadViewSchema} from './project-schemas.js';
import {THREAD_READ_POLICY,ThreadReadPolicySchema,threadStarting,deviceRefusal} from './project-thread-presentation-schemas.js';

export const ProjectThreadHeldSchema=z.strictObject({schema:z.literal('project-thread-held-v1'),projectId:IdSchema,threadId:IdSchema,tone:z.enum(['notice','error']),thread:ThreadIndexSchema.optional()}).superRefine((value,ctx)=>{
 if(value.thread&&(value.thread.id!==value.threadId||value.thread.projectId!==value.projectId))ctx.addIssue({code:'custom',message:'This indexed header belongs to another thread.'});
});
export type ProjectThreadHeld=z.infer<typeof ProjectThreadHeldSchema>;
export const ProjectThreadReadRequestSchema=z.strictObject({schema:z.literal('project-thread-read-request-v1'),projectId:IdSchema,threadId:IdSchema,viewKnown:z.boolean().default(false),indexKnown:z.boolean().default(false),heldTone:z.enum(['notice','error']).nullable().default(null)});
export const ProjectThreadReadErrorSchema=z.strictObject({schema:z.literal('project-thread-read-error-v1'),projectId:IdSchema,threadId:IdSchema,apiStatus:z.number().int().min(400).max(599).optional(),message:z.string(),indexAttempted:z.boolean().default(false),index:ThreadIndexSchema.nullable().optional()}).superRefine((value,ctx)=>{
 if(value.index&&(value.index.id!==value.threadId||value.index.projectId!==value.projectId))ctx.addIssue({code:'custom',message:'This index belongs to another thread.'});
});
export const ProjectThreadReadFailureContextSchema=z.strictObject({schema:z.literal('project-thread-read-failure-context-v1'),request:ProjectThreadReadRequestSchema,error:ProjectThreadReadErrorSchema,held:ProjectThreadHeldSchema.nullable().default(null),now:z.number().finite(),policy:ThreadReadPolicySchema.optional()}).superRefine((value,ctx)=>{
 if(value.error.projectId!==value.request.projectId||value.error.threadId!==value.request.threadId||value.held&&(value.held.projectId!==value.request.projectId||value.held.threadId!==value.request.threadId))ctx.addIssue({code:'custom',message:'This read failure belongs to another thread.'});
});
export const ProjectThreadReadFailureSchema=z.strictObject({schema:z.literal('project-thread-read-failure-v1'),projectId:IdSchema,threadId:IdSchema,route:z.enum(['global','starting','failed']),starting:z.boolean(),index:z.boolean(),error:z.discriminatedUnion('mode',[z.strictObject({mode:z.literal('retain')}),z.strictObject({mode:z.literal('set'),text:z.string()})]),held:ProjectThreadHeldSchema.nullable()});
export function projectThreadReadFailure(raw:unknown){
 const context=ProjectThreadReadFailureContextSchema.parse(raw),{request,error}=context,policy=context.policy??THREAD_READ_POLICY;
 const prior=context.held??(request.heldTone?ProjectThreadHeldSchema.parse({schema:'project-thread-held-v1',projectId:request.projectId,threadId:request.threadId,tone:request.heldTone}):null);
 const global=error.apiStatus===401,starting=!global&&error.apiStatus===404&&!request.viewKnown&&threadStarting(request.threadId,context.now,policy),refusal=!request.viewKnown&&error.apiStatus!==undefined?deviceRefusal(error.apiStatus):undefined;
 let held=prior;
 if(!global){
  if(starting){if(!held&&error.index)held=ProjectThreadHeldSchema.parse({schema:'project-thread-held-v1',projectId:request.projectId,threadId:request.threadId,tone:'notice',thread:error.index});}
  else if(prior||refusal){const thread=error.index??prior?.thread;held=ProjectThreadHeldSchema.parse({schema:'project-thread-held-v1',projectId:request.projectId,threadId:request.threadId,tone:refusal??'error',...(thread?{thread}:{})});}
 }
 return ProjectThreadReadFailureSchema.parse({schema:'project-thread-read-failure-v1',projectId:request.projectId,threadId:request.threadId,route:global?'global':starting?'starting':'failed',starting,index:!global&&!request.indexKnown&&!error.indexAttempted&&(starting||refusal!==undefined),error:global||starting?{mode:'retain'}:{mode:'set',text:error.message},held});
}
const frame={schema:z.literal('project-thread-read-view-v1'),projectId:IdSchema,threadId:IdSchema,request:ProjectThreadReadRequestSchema,nextRequest:ProjectThreadReadRequestSchema};
export const ProjectThreadReadViewSchema=z.discriminatedUnion('kind',[
 z.strictObject({...frame,kind:z.literal('ready'),view:ThreadViewSchema}),
 z.strictObject({...frame,kind:z.literal('failed'),error:ProjectThreadReadErrorSchema,failure:ProjectThreadReadFailureSchema}),
]).superRefine((value,ctx)=>{
 const same=(row:{projectId:string;threadId:string})=>row.projectId===value.projectId&&row.threadId===value.threadId;
 if(!same(value.request)||!same(value.nextRequest)||value.kind==='ready'&&(value.view.thread.projectId!==value.projectId||value.view.thread.id!==value.threadId)||value.kind==='failed'&&(!same(value.error)||!same(value.failure)))ctx.addIssue({code:'custom',message:'This read view belongs to another thread.'});
});
