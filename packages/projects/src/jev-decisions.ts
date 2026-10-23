import {existsSync,readdirSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {JevLessonInputSchema,JevLessonUseSchema,stableJson,type JevLessonUse,type ProjectHub,JEV_DECISION_PAGE_BYTES,JevDecisionPageSchema,JevPlacementDecisionSchema,IdSchema,readDocument,writeDocument,boundedRedaction,type Homes,type JevPlacementDecision,type SecretRedactor} from '@jevellan/core';
/** Durable project-scoped decision inputs belong to the managed home on the device that made the decision. */
export class ProjectJevDecisions{
 readonly #flushing=new Map<string,Promise<void>>();
 constructor(readonly o:{homes:Homes;deviceId:string;redactor:SecretRedactor;hub?:Pick<ProjectHub,'recordJevLessonUse'>}){}
 #directory(projectId:string){return this.o.homes.at('project-work',IdSchema.parse(projectId),'jev-decisions');}
 id(at:string){return `jdec_${String(Date.parse(at)).padStart(13,'0')}_${randomUUID().replaceAll('-','')}`;}
 async recordNew(raw:Omit<JevPlacementDecision,'id'>){
  const row=JevPlacementDecisionSchema.parse(boundedRedaction(this.o.redactor,{...raw,id:this.id(raw.at)})),use=this.#use(row);
  if(use&&this.o.hub?.recordJevLessonUse){this.o.homes.ensure('project-work',row.projectId,'jev-lesson-uses');writeDocument(this.#pending(row.projectId,row.id),JevLessonUseSchema,use);}
  this.record(row);if(use)await this.flushUses(row.projectId);return row.id;
 }
 #pending(projectId:string,id:string){return this.o.homes.at('project-work',IdSchema.parse(projectId),'jev-lesson-uses',`${IdSchema.parse(id)}.json`);}
 #use(row:JevPlacementDecision):JevLessonUse|undefined{
  if(row.source!=='jev'||!row.calls.length)return undefined;
  const state=JSON.parse(row.inputs.state) as {lessons?:unknown},lessons=JevLessonInputSchema.safeParse(state.lessons);
  return lessons.success&&lessons.data.items.length?JevLessonUseSchema.parse({schema:'jev-lesson-use-v1',id:row.id,projectId:row.projectId,deviceId:row.deviceId,questionSet:'p-v1',at:row.at,lessonKeys:lessons.data.items.map(row=>row.key)}):undefined;
 }
 async flushUses(projectId:string):Promise<void>{
  const prior=this.#flushing.get(projectId);if(prior)return prior;
  const operation=this.#flushUses(projectId);this.#flushing.set(projectId,operation);try{await operation;}finally{this.#flushing.delete(projectId);}
 }
 async #flushUses(projectId:string){
  const deliver=this.o.hub?.recordJevLessonUse;if(!deliver)return;
  const directory=this.o.homes.at('project-work',IdSchema.parse(projectId),'jev-lesson-uses');if(!existsSync(directory))return;
  const names=readdirSync(directory).filter(name=>/^jdec_[0-9]{13}_[a-f0-9]{32}\.json$/u.test(name)).sort().slice(0,50);
  for(const name of names){const id=name.slice(0,-5),path=this.#pending(projectId,id),use=readDocument(path,JevLessonUseSchema),row=this.read(projectId,id);
   if(!row){rmSync(path);continue;}
   if(stableJson(this.#use(row))!==stableJson(use))throw Error('Pending lesson use does not match its immutable Jev decision.');
   try{await deliver.call(this.o.hub,use);}catch{break;}
   rmSync(path);
  }
 }

 record(raw:JevPlacementDecision){const row=JevPlacementDecisionSchema.parse(boundedRedaction(this.o.redactor,raw));if(row.deviceId!==this.o.deviceId)throw Error('Only this device records its Jev inputs.');if(Buffer.byteLength(JSON.stringify(row))>JEV_DECISION_PAGE_BYTES)throw Object.assign(Error('This Jev input exceeds the storage budget.'),{status:413});const directory=this.o.homes.ensure('project-work',row.projectId,'jev-decisions'),path=this.o.homes.at('project-work',row.projectId,'jev-decisions',`${row.id}.json`);if(existsSync(path)){const previous=readDocument(path,JevPlacementDecisionSchema);if(JSON.stringify(previous)!==JSON.stringify(row))throw Error('A recorded Jev decision cannot be replaced.');return previous;}void directory;writeDocument(path,JevPlacementDecisionSchema,row);return row;}
 read(projectId:string,id:string){const path=this.o.homes.at('project-work',IdSchema.parse(projectId),'jev-decisions',`${IdSchema.parse(id)}.json`);if(!existsSync(path))return null;const row=readDocument(path,JevPlacementDecisionSchema);if(row.projectId!==projectId||row.deviceId!==this.o.deviceId)throw Error('This Jev input belongs to another project or device.');return row;}
 page(projectId:string,after?:string){if(after)IdSchema.parse(after);const directory=this.#directory(projectId),names=existsSync(directory)?readdirSync(directory).filter(name=>/^jdec_[0-9]{13}_[a-f0-9]{32}\.json$/u.test(name)).map(name=>name.slice(0,-5)).filter(id=>!after||id<after).sort().reverse():[],records:JevPlacementDecision[]=[];let bytes=0,next:string|null=null;for(const id of names){const row=this.read(projectId,id)!;const size=Buffer.byteLength(JSON.stringify(row));if(size>JEV_DECISION_PAGE_BYTES)throw Object.assign(Error('This Jev input exceeds the page budget.'),{status:413});if(records.length&&(records.length===100||bytes+size>JEV_DECISION_PAGE_BYTES)){next=records.at(-1)!.id;break;}records.push(row);bytes+=size;}return JevDecisionPageSchema.parse({schema:'jev-decision-page-v1',projectId,deviceId:this.o.deviceId,records,next});}
}
