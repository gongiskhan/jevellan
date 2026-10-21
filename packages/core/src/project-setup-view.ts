import{z}from'zod';
import{IdSchema,GitBranchChangeSchema,type GitBranchChange}from'./schemas.js';
import{ContextPanelSchema}from'./context-schemas.js';
export const PROJECT_SETUP_POLL_MS=500;
export const PROJECT_SETUP_WAITING_LABEL='Finishing project setup…';
const attention='Project setup needs attention. Open Context in Settings → Projects.';
export const ProjectSetupFactsSchema=z.strictObject({schema:z.literal('project-setup-facts-v1'),projectId:IdSchema,deviceId:IdSchema,panel:ContextPanelSchema});
export const ProjectSetupReadRequestSchema=z.strictObject({schema:z.literal('project-setup-read-request-v1')});
export const ProjectSetupWaitRequestSchema=z.strictObject({schema:z.literal('project-setup-wait-request-v1'),waitSeconds:z.number().int().min(0).max(30).default(0)});
export const ProjectSetupViewSchema=z.strictObject({schema:z.literal('project-setup-view-v1'),projectId:IdSchema,deviceId:IdSchema,state:z.enum(['ready','waiting','blocked']),pollMs:z.literal(PROJECT_SETUP_POLL_MS),refusal:z.string().nullable(),branchChange:GitBranchChangeSchema.nullable(),summary:z.string()});
export type ProjectSetupView=z.infer<typeof ProjectSetupViewSchema>;
export function projectSetupView(raw:unknown):ProjectSetupView{
 const{projectId,deviceId,panel}=ProjectSetupFactsSchema.parse(raw);
 if(panel.context.projectId!==projectId||panel.operations.some(row=>row.projectId!==projectId))throw new Error('The setup belongs to another project.');
 const incomplete=panel.operations.find(row=>!['completed','cancelled'].includes(row.status)),state=panel.busy?'waiting':incomplete?'blocked':'ready';
 const refusal=state==='blocked'?`${attention}${incomplete?.reason?` ${incomplete.reason}`:''}`:null;
 return ProjectSetupViewSchema.parse({schema:'project-setup-view-v1',projectId,deviceId,state,pollMs:PROJECT_SETUP_POLL_MS,refusal,branchChange:panel.operations.findLast(row=>row.branchChange)?.branchChange??null,summary:refusal??(state==='waiting'?'Project setup is running.':'Project setup is ready.')});
}
function setupPause(milliseconds:number,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{const aborted=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},milliseconds);signal.addEventListener('abort',aborted,{once:true});});
}
type Callbacks={waiting?:()=>void;branchChanged?:(change:GitBranchChange)=>void;completed?:(change:GitBranchChange)=>void};
/** The normal browser and bounded owner-tool wait use the same policy and abortable cadence. */
export async function waitForProjectSetupViews(read:(signal:AbortSignal)=>Promise<unknown>,signal:AbortSignal,callbacks:Callbacks={},pause:(milliseconds:number,signal:AbortSignal)=>Promise<void>=setupPause):Promise<ProjectSetupView>{
 let identity:string|undefined,lastBranchChange:string|undefined;
 for(;;){
  signal.throwIfAborted();const view=ProjectSetupViewSchema.parse(await read(signal));signal.throwIfAborted();const nextIdentity=JSON.stringify([view.projectId,view.deviceId]);
  if(identity!==undefined&&identity!==nextIdentity)throw new Error('The setup view belongs to another project or device.');identity=nextIdentity;
  const change=view.branchChange;
  if(change&&JSON.stringify(change)!==lastBranchChange){lastBranchChange=JSON.stringify(change);callbacks.branchChanged?.(change);if(change.status==='completed')callbacks.completed?.(change);}
  if(view.state==='ready')return view;
  if(view.state==='blocked')throw new Error(view.refusal??attention);
  callbacks.waiting?.();await pause(view.pollMs,signal);
 }
}
