import {createHash} from 'node:crypto';
import {boundedRedaction,IntakeActionSchema,stableJson,type DecisionAnswer,type IntakeAction,type IntakeCheck,type ProjectDecision,type ProjectHub,type SecretRedactor} from '@jevellan/core';
import {derivedId} from './decision-items.js';
import type {GitHubAccess} from './publication.js';
import type {ProjectTasks} from './tasks.js';
function refuse(message:string,status=409):never{throw Object.assign(Error(message),{status});}
type Options={hub:ProjectHub;github:GitHubAccess;tasks:ProjectTasks;deviceId:string;redactor:SecretRedactor;now():number;changed():void;prepareMerge?(check:IntakeCheck):Promise<void>;queueMerge?(action:IntakeAction,check:IntakeCheck):Promise<void>};
/** The coordinator records the owner's exact choice before any external mutation. */
export class ProjectIntakeActions{
 readonly #chains=new Map<string,Promise<unknown>>();
 constructor(readonly o:Options){}
 #at(){return new Date(this.o.now()).toISOString();}
 #exclusive<T>(id:string,action:()=>Promise<T>):Promise<T>{const result=(this.#chains.get(id)??Promise.resolve()).then(action),tail=result.then(()=>undefined,()=>undefined);this.#chains.set(id,tail);void tail.then(()=>{if(this.#chains.get(id)===tail)this.#chains.delete(id);});return result;}
 async #save(action:IntakeAction){const row=await this.o.hub.putIntakeDocument(IntakeActionSchema.parse(boundedRedaction(this.o.redactor,action)),action.revision);if(row.document.schema!=='intake-action-v1')throw Error('The intake action receipt changed type.');return row.document;}
 async answer(decision:ProjectDecision,answer:DecisionAnswer,request:{clientRequestId:string;expectedRevision?:number|undefined}):Promise<{repeated:boolean;closed:boolean}>{return this.#exclusive(decision.projectId,async()=>{
  if((await this.o.hub.coordinator(decision.projectId))?.document.deviceId!==this.o.deviceId)refuse('Intake choices run on the coordinator device.');
  if(!decision.intake)refuse('This is not an intake choice.',400);
  const id=derivedId('intake_action',decision.id,request.clientRequestId),digest=createHash('sha256').update(stableJson({decisionId:decision.id,answer})).digest('hex'),existing=(await this.o.hub.intakeDocument(id))?.document;
  let row=existing?.schema==='intake-action-v1'?existing:undefined;const repeated=!!row;
  if(row&&row.digest!==digest)refuse('This request ID already answered differently.');
  if(row?.state==='completed')return{repeated:true,closed:row.closed};
  const check=(await this.o.hub.intakeDocument(decision.intake.checkId))?.document;
  if(check?.schema!=='intake-check-v1'||check.status!=='checked'||check.projectId!==decision.projectId||check.pull.number!==decision.intake.number||check.pull.headSha!==decision.intake.head||check.runId!==decision.intake.runId)refuse('The intake check changed. Reload it.');
  if(!row){
   if(decision.answer||decision.withdrawnAt)refuse('This intake item is no longer open.');
   if(request.expectedRevision!==undefined&&request.expectedRevision!==decision.revision)refuse('This intake item changed. Reload it.');
   if(!answer.optionLabel||!['merge','redo','close','later'].includes(answer.optionLabel)||!decision.options.some(option=>option.label===answer.optionLabel))refuse('Choose an intake option.',400);
  }
  const token=await this.o.github.token(decision.projectId);if(!token)refuse('No GitHub token is saved for this project.');this.o.redactor.add(token);const client=this.o.github.client(token);
  if(!row||!row.prClosedAt){const current=await client.intakePull(check.repository,check.pull.number);if(current.headSha!==check.pull.headSha||current.merged||current.state!=='open')refuse('The pull request head or state changed. Check its new head first.');}
  if(answer.optionLabel==='merge'&&!this.o.queueMerge)refuse('Intake landing is unavailable.');
  if(answer.optionLabel==='merge')await this.o.prepareMerge?.(check);
  if(!row){
   row=await this.#save(IntakeActionSchema.parse({schema:'intake-action-v1',id,projectId:decision.projectId,revision:0,deviceId:this.o.deviceId,checkId:check.id,decisionId:decision.id,decisionRevision:decision.revision,clientRequestId:request.clientRequestId,digest,answer,state:'pending',closed:answer.optionLabel!=='later',commentState:'none',commentId:null,taskId:answer.optionLabel==='merge'?derivedId('task',id):null,prClosedAt:null,createdAt:this.#at(),completedAt:null}));
  }
  if(row.answer.optionLabel==='later'){await this.#save({...row,state:'completed',completedAt:this.#at()});this.o.changed();return{repeated,closed:false};}
  const note=row.answer.text;
  if(note&&row.commentState!=='posted'){
   // An uncertain network response must never silently duplicate an owner's comment.
   if(row.commentState==='posting')refuse('The previous comment delivery is unconfirmed. Inspect that pull request before repeating this choice.');
   row=await this.#save({...row,commentState:'posting'});const posted=await client.commentPull(check.repository,check.pull.number,note);row=await this.#save({...row,commentState:'posted',commentId:posted.id});
  }
  if(row.answer.optionLabel==='redo'){
   const failures=check.checks.filter(result=>!result.passed).map(result=>`${result.name}: ${result.tail.slice(-250)}`).join('\n')||'None.',prefix=`Redo ${check.pull.url}\n\n${check.stats!.files} files, +${check.stats!.added} -${check.stats!.deleted}.\nFailing checks:\n${failures}\n\nContributor description:\n`,suffix=`\n\nFull checked source: intake ${check.id} in the project journal.`,body=check.pull.body,remaining=20000-prefix.length-suffix.length;
   const brief=prefix+(body.length<=remaining?body:body.slice(0,Math.max(0,remaining-40))+'\n[Description continues in the journal.]')+suffix;
   const task=await this.o.tasks.create(check.projectId,{schema:'task-create-request-v1',clientRequestId:derivedId('intake_redo',decision.id),title:`Redo PR #${check.pull.number}: ${check.pull.title}`.slice(0,120),brief,type:'feature',goalId:null,now:false,after:[],needs:[],fixed:{}});
   row=await this.#save({...row,taskId:task.taskId});
  }
  if((row.answer.optionLabel==='close'||row.answer.optionLabel==='redo')&&!row.prClosedAt){await client.closePull(check.repository,check.pull.number);row=await this.#save({...row,prClosedAt:this.#at()});}
  await this.o.hub.answerDecision(decision.id,row.answer,this.#at(),row.clientRequestId);
  if(row.answer.optionLabel==='merge')await this.o.queueMerge!(row,check);
  await this.#save({...row,state:'completed',completedAt:this.#at()});this.o.changed();return{repeated,closed:true};
 });}
}
