import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ThreadStateSchema,type ThreadState} from './project-schemas.js';
import {ThreadReadHintSchema,threadReadHint} from './project-thread-presentation-schemas.js';

export const ProjectThreadReadFactsSchema=z.strictObject({schema:z.literal('project-thread-read-facts-v1'),projectId:IdSchema,threadId:IdSchema,state:ThreadStateSchema,readHint:ThreadReadHintSchema.optional(),cause:z.enum(['read','action']).default('read')});
export const ProjectThreadReaderRequestSchema=z.strictObject({schema:z.literal('project-thread-reader-request-v1'),projectId:IdSchema,threadId:IdSchema,initial:ProjectThreadReadFactsSchema.optional()});
export const ProjectThreadReadCompletionRequestSchema=z.strictObject({schema:z.literal('project-thread-read-completion-request-v1'),starting:z.boolean().default(false)});
export const ProjectThreadReadCompletionSchema=z.strictObject({schema:z.literal('project-thread-read-completion-v1'),readAgain:z.boolean(),pollHintMs:z.number().int().positive()});
export const ProjectThreadReadObservationSchema=z.strictObject({schema:z.literal('project-thread-read-observation-v1'),refreshSidebar:z.boolean(),readHint:ThreadReadHintSchema});
export const ProjectThreadReadActionSchema=z.strictObject({schema:z.literal('project-thread-read-action-v1'),fastUntil:z.number().finite()});

/** One transport lifetime. Browser cancellation and timer handles stay with the caller. */
export function projectThreadReader(raw:unknown,now:()=>number=Date.now){
 const request=ProjectThreadReaderRequestSchema.parse(raw);
 let reading=false,again=false,fastUntil=0,state:ThreadState|undefined,hint=threadReadHint(undefined,now());
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
  action(){fastUntil=now()+hint.policy.afterActionMs;return ProjectThreadReadActionSchema.parse({schema:'project-thread-read-action-v1',fastUntil});},
  complete(rawCompletion?:unknown){
   const completion=ProjectThreadReadCompletionRequestSchema.parse(rawCompletion??{schema:'project-thread-read-completion-request-v1'}),readAgain=again;
   reading=false;again=false;
   return ProjectThreadReadCompletionSchema.parse({schema:'project-thread-read-completion-v1',readAgain,pollHintMs:completion.starting||now()<fastUntil?hint.policy.liveMs:hint.pollHintMs});
  },
 };
}
