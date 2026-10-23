import {type JevLesson,type JevPlacementDecision,type JevReplaySummary,type LandingRoute,type MergeRoute} from '@jevellan/core';
import {PlacementStateSchema} from '@jevellan/decisions';
import type {Application} from './application.js';
import {newest,placementHistory} from './owner-jev-history.js';
import {replayLessonSnapshot,replayPlacement,replayReport,replayRoutes,saveReplay,usableReplayRoute} from './owner-jev-replay.js';

/** Exact stored attribution, never the larger policy snapshot or a guess from lesson prose. */
function placementUsedLesson(row:JevPlacementDecision,lesson:JevLesson){
 const state=PlacementStateSchema.parse(JSON.parse(row.inputs.state));
 return state.lessons?.items.some(item=>item.key===lesson.key)??false;
}
function routeUsedLesson(row:LandingRoute|MergeRoute,lesson:JevLesson){return row.lessonKeys?.includes(lesson.key)||row.lessons?.includes(lesson.id)||row.inputPacket?.lessons?.items.some(item=>item.key===lesson.key)||false;}

export async function replayLesson(app:Application,projectId:string,lesson:JevLesson,n:number){
 // Freeze the active comparison definitions once, including the price table; later edits are another replay.
 const settings=(await app.configuration()).configuration['x-jevellan'],lessons=replayLessonSnapshot(app,projectId),rules=app.ownerJev.rules(projectId),versions=['p-v1','l-v1','m-v1'].map(name=>app.ownerJev.active(name));
 let unreadableAttribution=0;
 const history=await placementHistory(app,projectId,n,row=>{if(row.source!=='jev')return false;try{return placementUsedLesson(row,lesson);}catch{unreadableAttribution++;return false;}});
 const related=(await app.projectWork.landings.records(projectId)).filter((row):row is LandingRoute|MergeRoute=>row.schema==='landing-route-v1'||row.schema==='merge-route-v1').filter(row=>routeUsedLesson(row,lesson)),unusableSkipped=related.filter(row=>!usableReplayRoute(row)).length,legacySkipped=related.filter(row=>usableReplayRoute(row)&&!row.inputPacket).length,routes=related.filter(row=>usableReplayRoute(row)&&row.inputPacket);
 const selected=newest([...history.records.map(row=>({id:row.id,at:row.at})),...routes.map(row=>({id:row.id,at:row.at}))]).slice(0,n),ids=new Set(selected.map(row=>row.id)),components:JevReplaySummary[]=[];
 const placements=history.records.filter(row=>ids.has(row.id));
 if(placements.length)components.push(await replayPlacement(app,projectId,versions.find(row=>row.name==='p-v1')!,null,rules,n,{sources:placements,history,settings,lessons}));
 for(const name of ['l-v1','m-v1'] as const){const sources=routes.filter(row=>row.questionSet===name&&ids.has(row.id));if(sources.length)components.push(await replayRoutes(app,projectId,name,versions.find(row=>row.name===name)!,null,rules,n,{sources,settings,lessons}));}
 const reports=components.map(row=>replayReport(app,projectId,row.id)),entries=reports.flatMap(row=>row.entries).sort((a,b)=>b.at.localeCompare(a.at)||b.sourceId.localeCompare(a.sourceId)),compared=entries.filter(row=>row.status==='compared').length,changed=entries.filter(row=>row.changed).length,unavailable=entries.length-compared,unknownCost=entries.filter(row=>row.status==='compared'&&row.cost.status==='unavailable').length,estimated=entries.filter(row=>row.cost.status==='estimated');
 const text=[`Replay on the last ${entries.length} decisions that used ${lesson.id}: ${changed} would change.`,...components.map(row=>row.text),...(estimated.length?[`Estimated change in token cost: ${estimated.reduce((sum,row)=>sum+(row.cost.deltaUsd??0),0).toFixed(6)} USD at ${settings.modelPrices?.version}.`]:[]),...(unknownCost?[`Changed-run cost unavailable for ${unknownCost}; missing evidence is never zero.`]:[]),...(unavailable?[`Unavailable or skipped comparisons: ${unavailable}.`]:[]),...(legacySkipped?[`Skipped ${legacySkipped} older decisions without immutable stored inputs.`]:[]),...(unusableSkipped?[`Skipped source records without a usable original Jev answer: ${unusableSkipped}.`]:[]),...(unreadableAttribution?[`Unreadable original lesson attribution: ${unreadableAttribution}; this replay is partial.`]:[]),...(history.unavailableDevices.length?[`Unavailable input devices: ${history.unavailableDevices.length}; this replay is partial.`]:[]),...(history.limitedDevices.length?[`History read limit reached on ${history.limitedDevices.length} devices; this replay is partial.`]:[])].join('\n').slice(0,12000);
 return saveReplay(app,projectId,{questionSet:'lessons',lessonId:lesson.id,requested:n,selected:entries.length,compared,changed,unavailable,priceTableVersion:settings.modelPrices?.version??null,priceTable:settings.modelPrices??null,unavailableDevices:history.unavailableDevices,historyLimitedDevices:history.limitedDevices,legacySkipped,unusableSkipped:unusableSkipped+unreadableAttribution,componentReports:components.map(row=>row.id),text,proposedPromptText:'',promptTexts:versions,proposedLessons:lessons.rows,rules,entries});
}
