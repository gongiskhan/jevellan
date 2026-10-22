import {JevDecisionPageSchema,PlacementRawChoiceSchema,ThreadViewSchema,type JevPlacementDecision,type JevRule,type PlacementRawChoice} from '@jevellan/core';
import {clampPlacementRules,fixedPlacementFields,type JevRuleContext,type PlacementInput} from '@jevellan/decisions';
import {ownerJevDecisionRead,ownerThreadOperation} from './project-work-api.js';
import type {Application} from './application.js';

export const newest=<T extends {at:string;id:string}>(rows:readonly T[])=>[...rows].sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id));
/** Bounded peer reads keep only the newest requested sources, not every device's full history. */
export async function placementHistory(app:Application,projectId:string,n:number,select:(row:JevPlacementDecision)=>boolean=()=>true){
  const devices=(await app.roster()).devices.filter(row=>!row.revoked).map(row=>row.device.id),unavailableDevices:string[]=[],limitedDevices:string[]=[];
  let position=0,records:JevPlacementDecision[]=[];
  await Promise.all(Array.from({length:Math.min(4,devices.length)},async()=>{
    for(;;){const deviceId=devices[position++];if(!deviceId)return;
      try{const found:JevPlacementDecision[]=[];let after:string|undefined,scanned=0,bytes=0;
        do{const page=JevDecisionPageSchema.parse(await ownerJevDecisionRead(app,projectId,{schema:'jev-decision-read-request-v1',projectId,deviceId,operation:'page',...(after?{after}:{})}));scanned+=page.records.length;bytes+=Buffer.byteLength(JSON.stringify(page.records));found.push(...page.records.filter(select));after=page.next??undefined;}while(after&&found.length<n&&scanned<2000&&bytes<16*1024*1024);
        if(after&&found.length<n)limitedDevices.push(deviceId);
        records=newest([...records,...found.slice(0,n)]).slice(0,n);
      }catch{unavailableDevices.push(deviceId);}
    }
  }));
  return{records,unavailableDevices,limitedDevices};
}
export function historicalInput(row:JevPlacementDecision):PlacementInput{return{...row.inputs.environment,runtimes:new Map(row.inputs.environment.runtimes)};}
export function historicalContext(row:JevPlacementDecision,rules:readonly JevRule[]):JevRuleContext|null{
  const conditional=rules.some(rule=>rule.enabled&&Object.keys(rule.when).length>0);
  if(!conditional)return{text:''};
  const stored=row.inputs.ruleContext;if(stored?.complete)return stored;
  // Old packets cannot prove the full original pre-redaction condition text. Missing evidence is not a negative match.
  return null;
}
export function choiceOf(row:Pick<PlacementRawChoice,'isolation'|'runtime'|'modelId'|'model'|'effortRequested'|'effortEffective'|'deviceId'|'accountId'>){
  return PlacementRawChoiceSchema.parse({schema:'placement-raw-choice-v1',isolation:row.isolation,runtime:row.runtime,modelId:row.modelId,model:row.model,effortRequested:row.effortRequested,effortEffective:row.effortEffective,deviceId:row.deviceId,accountId:row.accountId});
}
export function applyHistoricalRules(row:JevPlacementDecision,rules:readonly JevRule[]){
  const context=historicalContext(row,rules);if(!context)return null;
  const input=historicalInput(row),raw={...row.rawChoice,source:row.source,fixed:fixedPlacementFields(input.fixed),jevCalls:row.calls};
  return clampPlacementRules(input,raw,rules,context);
}
export const sameChoice=(a:PlacementRawChoice|null,b:PlacementRawChoice|null)=>JSON.stringify(a)===JSON.stringify(b);
export function choiceLabel(row:JevPlacementDecision,choice:PlacementRawChoice|null){
  if(!choice)return'not started';const env=row.inputs.environment,model=env.settings.menu.find(model=>model.id===choice.modelId)?.label??choice.modelId,account=env.accounts.find(account=>account.id===choice.accountId)?.label??choice.accountId;
  const device=env.devices.find(device=>device.id===choice.deviceId)?.name??choice.deviceId,runtime=env.runtimes.find(([id])=>id===choice.runtime)?.[1].displayName??choice.runtime;
  return`${model} ${choice.effortEffective} on ${account} (${runtime}, ${device}, ${choice.isolation})`;
}
/** Read only the normal owner view; retain no transcripts, native session identifiers or authentication state. */
export async function currentThreadFacts(app:Application,projectId:string){
  const rows=(await app.projectWork.view(projectId)).threads.slice(-50),facts=[],unavailableThreads:string[]=[];
  for(const row of rows){try{const view=ThreadViewSchema.parse(await ownerThreadOperation(app,projectId,row.id,'view'));facts.push({id:row.id,placement:view.placement,usage:view.thread.usage,turns:view.thread.turns,escalations:view.escalations?.length??0});}catch{unavailableThreads.push(row.id);}}
  return {facts,unavailableThreads};
}
