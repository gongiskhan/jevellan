import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ThreadStateSchema,ProjectWorkViewSchema,type ThreadState} from './project-schemas.js';
import {ThreadReadHintSchema,threadReadHint} from './project-thread-presentation-schemas.js';
import {ProjectThreadHeldSchema,ProjectThreadReadRequestSchema,ProjectThreadReadErrorSchema,projectThreadReadFailure,type ProjectThreadHeld} from './project-thread-read-state.js';

export const ProjectThreadReadFactsSchema=z.strictObject({schema:z.literal('project-thread-read-facts-v1'),projectId:IdSchema,threadId:IdSchema,state:ThreadStateSchema,readHint:ThreadReadHintSchema.optional(),cause:z.enum(['read','action']).default('read')});
export const ProjectThreadReaderRequestSchema=z.strictObject({schema:z.literal('project-thread-reader-request-v1'),projectId:IdSchema,threadId:IdSchema,initial:ProjectThreadReadFactsSchema.optional(),initialHeld:ProjectThreadHeldSchema.nullable().optional()});
export const ProjectThreadReadCompletionRequestSchema=z.strictObject({schema:z.literal('project-thread-read-completion-request-v1'),starting:z.boolean().default(false)});
export const ProjectThreadReadCompletionSchema=z.strictObject({schema:z.literal('project-thread-read-completion-v1'),readAgain:z.boolean(),pollHintMs:z.number().int().positive()});
export const ProjectThreadReadObservationSchema=z.strictObject({schema:z.literal('project-thread-read-observation-v1'),refreshSidebar:z.boolean(),readHint:ThreadReadHintSchema});
export const ProjectThreadReadActionSchema=z.strictObject({schema:z.literal('project-thread-read-action-v1'),fastUntil:z.number().finite()});

/** One transport lifetime. Browser cancellation and timer handles stay with the caller. */
export function projectThreadReader(raw:unknown,now:()=>number=Date.now){
 const request=ProjectThreadReaderRequestSchema.parse(raw);
 let reading=false,again=false,fastUntil=0,state:ThreadState|undefined,hint=threadReadHint(undefined,now());
 let indexKnown=false,lastStarting=false,held:ProjectThreadHeld|null=null;
 if(request.initialHeld?.projectId===request.projectId&&request.initialHeld.threadId===request.threadId)held=request.initialHeld;
 const readRequest=()=>ProjectThreadReadRequestSchema.parse({schema:'project-thread-read-request-v1',projectId:request.projectId,threadId:request.threadId,viewKnown:state!==undefined,indexKnown,heldTone:held?.tone??null});
 const accepted=(rawFacts:unknown)=>{
  const facts=ProjectThreadReadFactsSchema.parse(rawFacts);
  if(facts.projectId!==request.projectId||facts.threadId!==request.threadId)throw Object.assign(new Error('This read belongs to another thread.'),{status:502});
  const next=facts.readHint??threadReadHint(facts.state,now(),0,hint.policy),expected=threadReadHint(facts.state,now(),0,next.policy);
  if(next.pollHintMs!==expected.pollHintMs)throw Object.assign(new Error('The read hint does not match the thread state.'),{status:502});
  const refreshSidebar=facts.cause==='action'||state!==undefined&&state!==facts.state;
  state=facts.state;hint=next;
  return ProjectThreadReadObservationSchema.parse({schema:'project-thread-read-observation-v1',refreshSidebar,readHint:hint});
 };
 // A previous page can belong to another resource; it never seeds this reader's state.
 if(request.initial?.projectId===request.projectId&&request.initial.threadId===request.threadId)accepted(request.initial);
 return{
  begin(){if(reading){again=true;return false;}reading=true;return true;},
  accepted,
  readRequest,
  failed(rawError:unknown){
   const error=ProjectThreadReadErrorSchema.parse(rawError);
   const result=projectThreadReadFailure({schema:'project-thread-read-failure-context-v1',request:readRequest(),error,held,now:now(),policy:hint.policy});
   if(error.indexAttempted||result.index)indexKnown=true;
   lastStarting=result.starting;held=result.held?ProjectThreadHeldSchema.parse(result.held):null;
   return result;
  },
  indexed(rawWork:unknown){
   const work=ProjectWorkViewSchema.parse(rawWork);if(work.project.id!==request.projectId)throw Object.assign(new Error('This index belongs to another project.'),{status:502});
   const thread=work.threads.find(row=>row.id===request.threadId);
   if(thread&&(held||lastStarting))held=ProjectThreadHeldSchema.parse({schema:'project-thread-held-v1',projectId:request.projectId,threadId:request.threadId,tone:held?.tone??'notice',thread});
   return held?ProjectThreadHeldSchema.parse(held):null;
  },
  action(){fastUntil=now()+hint.policy.afterActionMs;return ProjectThreadReadActionSchema.parse({schema:'project-thread-read-action-v1',fastUntil});},
  complete(rawCompletion?:unknown){
   const completion=ProjectThreadReadCompletionRequestSchema.parse(rawCompletion??{schema:'project-thread-read-completion-request-v1'}),readAgain=again;
   reading=false;again=false;
   return ProjectThreadReadCompletionSchema.parse({schema:'project-thread-read-completion-v1',readAgain,pollHintMs:completion.starting||now()<fastUntil?hint.policy.liveMs:hint.pollHintMs});
  },
 };
}
