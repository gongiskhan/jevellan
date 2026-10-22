import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {boundedRedaction,JevReplayReportSchema,JevReplaySummarySchema,readDocument,writeDocument,type JevPromptVersion,type JevProposal,type JevReplayEntry,type JevReplayReport,type JevReplaySummary,type JevRule} from '@jevellan/core';
import {applyJevRouteRules,clampPlacementRules,deadlineClient,decideLandingRoute,decideMergeRoute,decidePlacement,estimateReplayCost,parseLandingPrompt,parseMergePrompt,parsePlacementPrompt,PlacementStateSchema} from '@jevellan/decisions';
import type {Application} from './application.js';
import {choiceLabel,choiceOf,currentThreadFacts,historicalContext,historicalInput,newest,placementHistory,sameChoice} from './owner-jev-history.js';

const namespace='owner-jev-replays';
export function replaySummary(app:Application,projectId:string,id:string):JevReplaySummary{
  const stored=app.hub.get(namespace,id,JevReplaySummarySchema)?.document;
  if(!stored||stored.projectId!==projectId)throw Object.assign(Error('Replay report not found in this project.'),{status:404});
  return stored;
}
export function replayReport(app:Application,projectId:string,id:string){
  replaySummary(app,projectId,id);const path=app.homes.at('jev-replays',projectId,`${id}.json`);
  if(!existsSync(path))throw Object.assign(Error('The full replay report is unavailable on its original device.'),{status:503});
  const report=readDocument(path,JevReplayReportSchema);if(report.projectId!==projectId||report.id!==id)throw Error('Replay report identity does not match.');return report;
}
export async function replayPlacement(app:Application,projectId:string,version:JevPromptVersion,proposal:JevProposal|null,rules:JevRule[],n:number){
  const promptText=proposal?.text??version.text,prompt=parsePlacementPrompt(promptText),history=await placementHistory(app,projectId,n,row=>row.source==='jev'),sources=history.records.slice(0,n),entries:JevReplayEntry[]=[],lines:string[]=[];
  const settings=(await app.configuration()).configuration['x-jevellan'],model=settings.decisions.model,table=settings.modelPrices,current=await currentThreadFacts(app,projectId);
  for(const row of sources){
    const base={schema:'jev-replay-entry-v1' as const,sourceId:row.id,deviceId:row.deviceId,...(row.threadId?{threadId:row.threadId}:{}),at:row.at,input:row,originalChoice:row.finalChoice};
    const context=historicalContext(row,rules);
    if(!context){entries.push({...base,status:'skipped',changed:null,rawChoice:null,finalChoice:null,reason:'The original rule condition context is unavailable.',rulesApplied:[],calls:[],cost:{status:'unavailable',reason:'This source cannot be compared.',oldUsd:null,newUsd:null,deltaUsd:null}});continue;}
    try{
      const state=PlacementStateSchema.parse(JSON.parse(row.inputs.state)),input=historicalInput(row),result=await decidePlacement(deadlineClient(app.decisionClient),{...input,prompt,storedState:row.inputs.state,packet:{title:state.thread.title,task:state.thread.task,taskContext:state.task,activeThreads:[],overrides:[]},jevModel:model,redactor:app.redactor},new AbortController().signal);
      if(result.kind!=='placed'||result.record.source!=='jev'){
        entries.push({...base,status:'unavailable',changed:null,rawChoice:null,finalChoice:null,reason:result.kind==='refused'?result.message:'Jev did not return a usable replay answer.',rulesApplied:[],calls:result.kind==='placed'?result.record.jevCalls:[],cost:{status:'unavailable',reason:'This source cannot be compared.',oldUsd:null,newUsd:null,deltaUsd:null}});continue;
      }
      const rawChoice=choiceOf(result.record),clamped=clampPlacementRules(input,result.record,rules,context),finalChoice=clamped.kind==='placed'?choiceOf(clamped.record):null,changed=!sameChoice(row.finalChoice,finalChoice);
      const fact=current.facts.find(fact=>fact.placement.inputsRef===row.id&&fact.placement.source==='jev'&&fact.placement.modelId===row.finalChoice?.modelId),usage=fact?.usage;
      const runUsage=fact&&usage&&fact.turns===usage.turns&&fact.turns>0&&fact.escalations===0&&(!row.inputs.environment.reason||row.inputs.environment.reason==='start')?{schema:'jev-replay-run-usage-v1' as const,threadId:fact.id,placementInputsRef:row.id,modelId:fact.placement.modelId,turns:fact.turns,usage}:undefined;
      const cost=estimateReplayCost(runUsage?.usage,row.finalChoice?.modelId,finalChoice?.modelId,table);
      entries.push({...base,status:'compared',changed,rawChoice,finalChoice,reason:clamped.reason||'The ordinary placement candidates and owner rules were reapplied.',rulesApplied:clamped.rulesApplied,calls:result.record.jevCalls,...(runUsage?{runUsage}:{}),cost});
      if(changed){const d=app.ownerTools.ids.one(projectId,'D',row.id),t=row.threadId?app.ownerTools.ids.shortOf(projectId,row.threadId)??'':'';lines.push(`${d} ${t} ${choiceLabel(row,row.finalChoice)} to ${choiceLabel(row,finalChoice)}`.replace(/  +/gu,' ').slice(0,300));}
    }catch(error){entries.push({...base,status:'unavailable',changed:null,rawChoice:null,finalChoice:null,reason:app.redactor.text(error instanceof Error?error.message:'Replay unavailable.').slice(0,4000),rulesApplied:[],calls:[],cost:{status:'unavailable',reason:'This source cannot be compared.',oldUsd:null,newUsd:null,deltaUsd:null}});}
  }
  const changed=entries.filter(row=>row.changed).length,compared=entries.filter(row=>row.status==='compared').length,unavailable=entries.length-compared,costUnknown=entries.filter(row=>row.status==='compared'&&row.cost.status==='unavailable').length;
  const text=[`Replay on the last ${entries.length} decisions that used p-v1: ${changed} would change.`,...lines,costUnknown?`Estimated cost of changed runs: unavailable for ${costUnknown}; missing rates or verified recorded run usage are never treated as zero.`:entries.some(row=>row.cost.status==='estimated')?`Estimated change in token cost: ${entries.reduce((sum,row)=>sum+(row.cost.deltaUsd??0),0).toFixed(6)} USD at ${table?.version}.`:'Estimated cost of the changed runs: model changes only; none in this replay.',...(unavailable?[`Unavailable or skipped sources: ${unavailable}.`]:[]),...(history.unavailableDevices.length?[`Unavailable input devices: ${history.unavailableDevices.length}.`]:[]),...(history.limitedDevices.length?[`History read limit reached on ${history.limitedDevices.length} devices; this replay is partial.`]:[])].join('\n').slice(0,10000);
  return saveReplay(app,projectId,{questionSet:'p-v1',...(proposal?{proposalId:proposal.id}:{}),requested:n,selected:entries.length,compared,changed,unavailable,priceTableVersion:table?.version??null,priceTable:table??null,unavailableDevices:history.unavailableDevices,historyLimitedDevices:history.limitedDevices,text,proposedPromptText:promptText,rules,entries});
}

function saveReplay(app:Application,projectId:string,fields:Omit<JevReplayReport,'schema'|'id'|'projectId'|'deviceId'|'at'|'evidence'|'engineVersion'>){
  const id=`jrep_${Date.now()}_${randomUUID().replaceAll('-','')}`,at=new Date().toISOString(),report=JevReplayReportSchema.parse(boundedRedaction(app.redactor,{...fields,schema:'jev-replay-report-v1',id,projectId,deviceId:app.device.deviceId,at,evidence:app.verificationEvidence,engineVersion:app.version}));
  if(Buffer.byteLength(JSON.stringify(report))>64*1024*1024)throw Error('The replay report exceeds its storage budget.');
  app.homes.ensure('jev-replays',projectId);writeDocument(app.homes.at('jev-replays',projectId,`${id}.json`),JevReplayReportSchema,report);
  const{entries:_entries,proposedPromptText:_prompt,rules:_rules,priceTable:_prices,...metadata}=report;void _entries;void _prompt;void _rules;void _prices;
  const summary=JevReplaySummarySchema.parse({...metadata,schema:'jev-replay-summary-v1'});app.hub.put(namespace,id,JevReplaySummarySchema,summary,0);return summary;
}
export async function replayRoutes(app:Application,projectId:string,name:'l-v1'|'m-v1',version:JevPromptVersion,proposal:JevProposal|null,rules:JevRule[],n:number){
  const records=(await app.projectWork.landings.records(projectId)).filter(row=>row.schema==='landing-route-v1'||row.schema==='merge-route-v1').filter(row=>row.questionSet===name&&(row.source==='jev'||!!row.rawChoice&&row.calls.length>0)),legacySkipped=records.filter(row=>!row.inputPacket).length,sources=newest(records.filter(row=>row.inputPacket)).slice(0,n),entries:JevReplayEntry[]=[],lines:string[]=[],settings=(await app.configuration()).configuration['x-jevellan'],promptText=proposal?.text??version.text;
  for(const row of sources){
    const base={schema:'jev-replay-entry-v1' as const,sourceId:row.id,deviceId:row.deviceId,threadId:row.threadId,at:row.at,input:row,originalChoice:row.route};
    try{
      const context=row.ruleContext?.complete?row.ruleContext:rules.some(rule=>rule.enabled&&Object.keys(rule.when).length)?null:{text:''};
      if(!context){entries.push({...base,status:'skipped',changed:null,rawChoice:null,finalChoice:null,reason:'The original condition context is unavailable.',rulesApplied:[],calls:[],cost:{status:'unavailable',reason:'This source cannot be compared.',oldUsd:null,newUsd:null,deltaUsd:null}});continue;}
      const result=row.schema==='landing-route-v1'?await decideLandingRoute(app.decisionClient,row.inputPacket!,settings.decisions.model,app.redactor,new AbortController().signal,parseLandingPrompt(promptText)):await decideMergeRoute(app.decisionClient,row.inputPacket!,settings.decisions.model,app.redactor,new AbortController().signal,parseMergePrompt(promptText));
      if(result.source!=='jev'){entries.push({...base,status:'unavailable',changed:null,rawChoice:null,finalChoice:null,reason:result.reason,rulesApplied:[],calls:result.calls,cost:{status:'unavailable',reason:'This source cannot be compared.',oldUsd:null,newUsd:null,deltaUsd:null}});continue;}
      const raw=result.route,landing=raw==='merge'?'land':raw==='test-then-merge'?'verify-then-land':raw,ruled=applyJevRouteRules(projectId,landing,rules,context),mapped=row.schema==='merge-route-v1'?ruled.route==='land'?'merge':ruled.route==='verify-then-land'?'test-then-merge':ruled.route:ruled.route,final=row.source==='guard'?row.route:mapped,changed=final!==row.route;
      entries.push({...base,status:'compared',changed,rawChoice:raw,finalChoice:final,reason:row.source==='guard'?'The recorded hard-guard refusal is retained.':ruled.reason||'The route rules were reapplied to the recorded input.',rulesApplied:ruled.rulesApplied,calls:result.calls,cost:{status:'not-needed',reason:'No model change to estimate.',oldUsd:null,newUsd:null,deltaUsd:0}});
      if(changed)lines.push(`${app.ownerTools.ids.one(projectId,'D',row.id)} ${app.ownerTools.ids.shortOf(projectId,row.threadId)??''} ${row.route} to ${final}`.replace(/  +/gu,' '));
    }catch(error){entries.push({...base,status:'unavailable',changed:null,rawChoice:null,finalChoice:null,reason:app.redactor.text(error instanceof Error?error.message:'Replay unavailable.').slice(0,4000),rulesApplied:[],calls:[],cost:{status:'unavailable',reason:'This source cannot be compared.',oldUsd:null,newUsd:null,deltaUsd:null}});}
  }
  const changed=entries.filter(row=>row.changed).length,compared=entries.filter(row=>row.status==='compared').length,unavailable=entries.length-compared,text=[`Replay on the last ${entries.length} decisions that used ${name}: ${changed} would change.`,...lines,'Estimated cost of the changed runs: model changes only; none in this replay.',...(legacySkipped?[`Skipped ${legacySkipped} older decisions without immutable stored inputs.`]:[]),...(unavailable?[`Unavailable or skipped sources: ${unavailable}.`]:[])].join('\n').slice(0,10000);
  return saveReplay(app,projectId,{questionSet:name,...(proposal?{proposalId:proposal.id}:{}),requested:n,selected:entries.length,compared,changed,unavailable,priceTableVersion:settings.modelPrices?.version??null,priceTable:settings.modelPrices??null,unavailableDevices:[],legacySkipped,text,proposedPromptText:promptText,rules,entries});
}
