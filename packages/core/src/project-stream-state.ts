import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ProjectCoordinatorActivitySchema,ProjectEventFrameSchema,ProjectLedgerEventSchema,type ProjectCoordinatorActivity,type ProjectLedgerEvent} from './project-schemas.js';
import {ProjectViewNoticeSchema,type ProjectViewNotice} from './project-view-notice-schemas.js';
import {projectHistory} from './project-history.js';

const count=z.number().int().nonnegative();
export const ProjectStreamPolicySchema=z.strictObject({schema:z.literal('project-stream-policy-v1'),initialRetryMs:z.literal(5000),maximumRetryMs:z.literal(60000),retryMultiplier:z.literal(2)});
export const PROJECT_STREAM_POLICY=Object.freeze(ProjectStreamPolicySchema.parse({schema:'project-stream-policy-v1',initialRetryMs:5000,maximumRetryMs:60000,retryMultiplier:2}));
export const ProjectStreamContextSchema=z.strictObject({schema:z.literal('project-stream-context-v1'),projectId:IdSchema,hereDeviceId:IdSchema,baseline:count.optional()});
export const ProjectStreamSnapshotSchema=z.strictObject({schema:z.literal('project-stream-snapshot-v1'),projectId:IdSchema,coordinatorDeviceId:IdSchema.nullable(),lastEventId:count});
export const ProjectStreamUpdateSchema=z.strictObject({schema:z.literal('project-stream-update-v1'),refresh:z.boolean(),events:z.array(ProjectLedgerEventSchema).optional(),notices:z.array(ProjectViewNoticeSchema).optional(),coordinatorActivity:ProjectCoordinatorActivitySchema.optional()});
export const ProjectStreamSnapshotResultSchema=z.strictObject({schema:z.literal('project-stream-snapshot-result-v1'),accepted:z.boolean(),initial:z.boolean(),moved:z.boolean(),baseline:count.optional(),update:ProjectStreamUpdateSchema});
export type ProjectStreamUpdate=z.infer<typeof ProjectStreamUpdateSchema>;
export type ProjectStreamSnapshotResult=z.infer<typeof ProjectStreamSnapshotResultSchema>;

/** One coordinator device's replay state. Connections, timers and callbacks remain transport-owned. */
export class ProjectStreamState {
 readonly #context:z.infer<typeof ProjectStreamContextSchema>;
 #device:string|undefined;
 #baseline:number|undefined;
 #after=0;
 #delay:number=PROJECT_STREAM_POLICY.initialRetryMs;
 #history=projectHistory();
 #ready=false;
 #events:ProjectLedgerEvent[]=[];
 #notices:ProjectViewNotice[]=[];
 #activity:ProjectCoordinatorActivity|undefined;
 constructor(raw:unknown){this.#context=ProjectStreamContextSchema.parse(raw);this.#baseline=this.#context.baseline;}
 get after(){return this.#after;}
 opened(){this.#delay=PROJECT_STREAM_POLICY.initialRetryMs;}
 retryDelay(){const delay=this.#delay;this.#delay=Math.min(delay*PROJECT_STREAM_POLICY.retryMultiplier,PROJECT_STREAM_POLICY.maximumRetryMs);return delay;}
 #empty():ProjectStreamUpdate{return{schema:'project-stream-update-v1',refresh:false};}
 #publish(events:ProjectLedgerEvent[]|undefined):ProjectStreamUpdate{
  if(events===undefined)return this.#empty();
  this.#ready=true;this.#events=events;return{schema:'project-stream-update-v1',refresh:false,events};
 }
 snapshot(raw:unknown):ProjectStreamSnapshotResult{
  const next=ProjectStreamSnapshotSchema.parse(raw),update=this.#empty();
  if(next.projectId!==this.#context.projectId)return{schema:'project-stream-snapshot-result-v1',accepted:false,initial:false,moved:false,update};
  const device=next.coordinatorDeviceId??this.#context.hereDeviceId,moved=this.#device!==undefined&&device!==this.#device,initial=this.#baseline===undefined;
  this.#device=device;
  if(initial||moved)this.#baseline=next.lastEventId;
  if(moved){this.#after=0;this.opened();this.#history=projectHistory();this.#ready=false;this.#events=[];this.#notices=[];this.#activity=undefined;}
  return{schema:'project-stream-snapshot-result-v1',accepted:true,initial,moved,baseline:this.#baseline,update:this.#ready?update:this.#publish(this.#history.snapshot(next.lastEventId))};
 }
 /** Preserve the existing cursor wire coercion; malformed JSON still throws at its transport boundary. */
 cursor(data:string):ProjectStreamUpdate{
  const id=Number((JSON.parse(data) as {id?:unknown}).id);
  if(!Number.isSafeInteger(id))return this.#empty();
  this.#after=Math.max(this.#after,id);
  if(this.#ready)return this.#empty();
  const update=this.#publish(this.#history.advance(id));return{...update,refresh:update.events!==undefined};
 }
 frame(raw:unknown):ProjectStreamUpdate{
  const document=ProjectEventFrameSchema.parse(typeof raw==='string'?JSON.parse(raw):raw),value=document.event;
  if(document.notices?.length)this.#notices=[...new Map([...this.#notices,...document.notices].map(notice=>[notice.id,notice])).values()];
  const activity=document.coordinatorActivity;
  if(activity&&(!this.#activity||activity.seq>this.#activity.seq))this.#activity=activity;
  this.#after=Math.max(this.#after,value.id);
  const update=this.#ready?{schema:'project-stream-update-v1' as const,refresh:true,events:this.#events.some(entry=>entry.id===value.id)?this.#events:[...this.#events,value].sort((a,b)=>a.id-b.id)}:this.#publish(this.#history.add(value));
  if(update.events!==undefined)this.#events=update.events;
  // Do not parse/clone the accumulated history: live duplicate delivery retains array identity.
  return{...update,refresh:update.events!==undefined, ...(document.notices?.length?{notices:this.#notices}:{}),...(activity&&this.#activity?{coordinatorActivity:this.#activity}:{})};
 }
}
export function projectStreamState(raw:unknown){return new ProjectStreamState(raw);}
