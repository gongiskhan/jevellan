import {afterEach,expect,test} from 'vitest';
import {JevReplayReportSchema,ThreadCreatedViewSchema,readDocument,type JevReplayReport} from '../packages/core/dist/index.js';
import {forThread} from '../packages/runtime-contract/dist/index.js';
import {reportStep,type ProjectFixture} from './helpers/project-fixture.js';
import {placementRuleFixture} from './helpers/placement-rule-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
const prices=(large=true)=>({schema:'model-price-table-v1' as const,version:'prices_owned_v1',entries:[{modelId:'small',inputUsdPerMillion:2,outputUsdPerMillion:10},...(large?[{modelId:'large',inputUsdPerMillion:4,outputUsdPerMillion:20}]:[])]});
async function prepare(table?:ReturnType<typeof prices>,usage=true){
  const made=await placementRuleFixture();f=made.f;
  if(table){const before=f.app.hub.configuration.current()!,configuration={...before.configuration,'x-jevellan':{...before.configuration['x-jevellan'],modelPrices:table}};f.app.hub.configuration.put(configuration,before.revision,{deviceId:f.app.device.deviceId,source:'ui'});}
  made.first.enqueueTurn(async turn=>{if(usage)turn.emit({type:'usage',inputTokens:1000,outputTokens:100,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0.003});return reportStep({status:'progress',summary:'Recorded owned run.'})(turn);},forThread());
  const receipt=await f.json('/api/projects/project/threads',ThreadCreatedViewSchema,'POST',{schema:'thread-create-request-v1',clientRequestId:'replay_evidence_run',title:'Owned evidence work',task:'Change only the fictional fixture.'});await f.waitFor(()=>f!.thread(receipt.threadId),row=>row.state==='idle');await f.app.projectWork.idle();await f.app.projectWork.usage.refresh('project');const source=f.app.projectWork.jevDecisions.read('project',f.thread(receipt.threadId).placement.inputsRef!)!;return{...made,thread:f.thread(receipt.threadId),source};
}
async function propose(made:Awaited<ReturnType<typeof prepare>>){
  made.choices.pick_model='large';made.choices.effort='high';const result=await f!.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'bridge:project',args:{action:'prompt_propose',name:'p-v1',edits:[{find:'Choose the model that should carry this thread end to end.',replace:'Choose the owned comparison model.'}],summary:'Owned evidence replay.'}});expect(result.ok).toBe(true);if(!result.ok)throw Error('Owned evidence proposal refused.');const proposal=f!.app.ownerJev.proposals().find(row=>row.id===result.text.match(/^P[1-9][0-9]*/u)![0])!;expect(proposal.replayReportId).toBeDefined();const report=readDocument(f!.homes.at('jev-replays','project',`${proposal.replayReportId!}.json`),JevReplayReportSchema);return{report,text:result.text,id:proposal.replayReportId!};
}
function entry(report:JevReplayReport){expect(report.entries).toHaveLength(1);return report.entries[0]!;}
test('normal owner report reads are project-bound and the full managed evidence preserves exact input and output',async()=>{
  const made=await prepare(),{report,id}=await propose(made),reply=await f!.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'bridge:project',args:{action:'replay_report',report:id}});expect(reply).toMatchObject({ok:true,data:{schema:'jev-replay-summary-v1',id,questionSet:'p-v1',selected:1,compared:1,changed:1,priceTableVersion:null,evidence:'simulated'}});expect(entry(report)).toMatchObject({input:made.source,rawChoice:{modelId:'large'},finalChoice:{modelId:'large'},status:'compared',cost:{status:'unavailable'}});expect(report.proposedPromptText).toContain('Choose the owned comparison model.');expect(report.rules).toEqual([]);expect(()=>f!.app.ownerJev.replayReport('other_project',id)).toThrow(/not found/u);expect(JSON.stringify(report)).not.toContain(f!.jevKey!);expect(JSON.stringify(report)).not.toContain(f!.token);expect(made.first.runs).toHaveLength(1);expect(made.second.runs).toHaveLength(0);
});
test('versioned replay prices use recorded run tokens rather than the Jev decision-call tokens',async()=>{
  const made=await prepare(prices()),{report}=await propose(made);expect(made.source.threadId).toBe(made.thread.id);expect(report.priceTableVersion).toBe('prices_owned_v1');expect(entry(report).cost).toMatchObject({status:'estimated'});expect(entry(report).cost.oldUsd).toBeCloseTo(0.003,9);expect(entry(report).cost.newUsd).toBeCloseTo(0.006,9);expect(entry(report).cost.deltaUsd).toBeCloseTo(0.003,9);expect(entry(report).calls[0]?.usage).toEqual({input_tokens:40,output_tokens:4});expect(made.first.runs).toHaveLength(1);expect(made.second.runs).toHaveLength(0);
});
test('a missing model rate is unavailable and never converted to a zero-cost estimate',async()=>{
  const made=await prepare(prices(false)),{report,text}=await propose(made);expect(report.priceTableVersion).toBe('prices_owned_v1');expect(entry(report).cost).toMatchObject({status:'unavailable',oldUsd:null,newUsd:null,deltaUsd:null});expect(text.toLowerCase()).toContain('unavailable');
});
test('missing recorded run usage stays unavailable even when Jev returned usage and prices exist',async()=>{
  const made=await prepare(prices(),false),{report}=await propose(made);expect(entry(report).calls[0]?.usage.input_tokens).toBe(40);expect(entry(report).cost).toMatchObject({status:'unavailable',oldUsd:null,newUsd:null,deltaUsd:null});
});
test('an unreadable legacy condition packet is reported unavailable without failing an already saved rule',async()=>{
  const made=await prepare(),repo=f!.app.projectWork.jevDecisions,{ruleContext:_context,...legacy}=made.source.inputs;void _context;const at=new Date(Date.parse(made.source.at)+1).toISOString();repo.record({...made.source,id:repo.id(at),at,inputs:{...legacy,state:'{broken legacy packet'}});const calls=made.calls.length,result=await f!.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'bridge:project',args:{action:'rule_set',when:{keywords:['fictional']},set:{minEffort:'high'}}});expect(result).toMatchObject({ok:true});if(!result.ok)throw Error('Owned partial history refused.');expect(result.text).toContain('would have changed 1');expect(result.text).toContain('Unavailable original condition contexts: 1');expect(made.calls).toHaveLength(calls);expect(f!.app.ownerJev.rules('project')).toHaveLength(1);
});
