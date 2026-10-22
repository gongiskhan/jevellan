import {afterEach,expect,test} from 'vitest';
import {ThreadCreatedViewSchema} from '../packages/core/dist/index.js';
import {forThread} from '../packages/runtime-contract/dist/index.js';
import {reportStep,type ProjectFixture} from './helpers/project-fixture.js';
import {placementRuleFixture} from './helpers/placement-rule-fixture.js';

let f:ProjectFixture|undefined;
afterEach(async()=>{await f?.close();f=undefined;});
async function owner(action:string,args:Record<string,unknown>={}){
  const result=await f!.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'bridge:project',args:{action,...args}});
  expect(result.ok).toBe(true);
  if(!result.ok)throw Error('Owned history command refused.');
  return result;
}
async function started(made:Awaited<ReturnType<typeof placementRuleFixture>>,id:string,task='Change only the fictional fixture.',fixed:Record<string,string>={}){
  for(const runtime of[made.first,made.second])runtime.enqueueTurn(reportStep({status:'progress',summary:'Owned history work.'}),forThread());
  const receipt=await made.f.json('/api/projects/project/threads',ThreadCreatedViewSchema,'POST',{schema:'thread-create-request-v1',clientRequestId:id,title:'History '+id,task,...fixed});
  await made.f.waitFor(()=>made.f.app.projectWork.store.get(receipt.threadId),row=>row?.state==='idle');
  return made.f.thread(receipt.threadId);
}
const effect=(text:string)=>text.slice(text.indexOf('\n')+1);

test('rule effects compare model account and effort with stored raw choices without model calls or retroactive work',async()=>{
  const made=await placementRuleFixture();f=made.f;const thread=await started(made,'history_fields'),before=structuredClone(thread),calls=made.calls.length;
  const saved=await owner('rule_set',{set:{minModel:'large',minEffort:'high',account:'acc_large'}}),result=effect(saved.text);
  expect(result).toContain('would have changed 1');expect(result).toContain('Small fixture');expect(result).toContain('Large fixture');expect(result).toContain('Large account');
  expect(made.calls).toHaveLength(calls);expect(f.thread(thread.id)).toEqual(before);expect(made.first.runs).toHaveLength(1);expect(made.second.runs).toHaveLength(0);
});

test('removing a rule measures restoration from the raw choice rather than re-clamping the final effort',async()=>{
  const made=await placementRuleFixture();f=made.f;const rule=await f.app.ownerJev.saveRule('project',{set:{minModel:'large',minEffort:'high',account:'acc_large'}}),thread=await started(made,'history_remove'),before=structuredClone(thread),calls=made.calls.length;
  expect(thread.placement).toMatchObject({modelId:'large',rawChoice:{modelId:'small',effortRequested:'low'}});
  const removed=effect((await owner('rule_remove',{rule:rule.id})).text);expect(removed).toContain('would have changed 1');expect(removed).toContain('Large fixture');expect(removed).toContain('Small fixture');
  expect(made.calls).toHaveLength(calls);expect(f.thread(thread.id)).toEqual(before);expect(made.second.runs).toHaveLength(1);
});

test('historical keyword conditions retain the full condition text beyond the Jev packet cut',async()=>{
  const made=await placementRuleFixture();f=made.f;const thread=await started(made,'history_long_task','x'.repeat(9000)+' fixturetail'),calls=made.calls.length,snapshot=f.app.projectWork.jevDecisions.read('project',thread.placement.inputsRef!)!;
  expect(JSON.parse(snapshot.inputs.state).thread.task).not.toContain('fixturetail');
  const saved=effect((await owner('rule_set',{when:{keywords:['fixturetail']},set:{minEffort:'high'}})).text);expect(saved).toContain('would have changed 1');expect(snapshot.inputs).toMatchObject({ruleContext:{complete:true,text:expect.stringContaining('fixturetail')}});expect(made.calls).toHaveLength(calls);
});

test('rule effects do not invent a change to fully fixed owner choices without stored inputs',async()=>{
  const made=await placementRuleFixture();f=made.f;const thread=await started(made,'history_fixed','Change the fictional fixture.',{isolation:'worktree',modelId:'small',effort:'medium',deviceId:f.app.device.deviceId});
  expect(thread.placement).toMatchObject({source:'fixed',effortRequested:'medium'});expect(thread.placement.inputsRef).toBeUndefined();
  expect(effect((await owner('rule_set',{set:{minEffort:'high'}})).text)).toContain('would have changed 0');expect(made.calls).toHaveLength(0);expect(f.thread(thread.id).placement.effortRequested).toBe('medium');
});

test('rule effects use the last thirty stored decisions rather than only current thread rows',async()=>{
  const made=await placementRuleFixture();f=made.f;const thread=await started(made,'history_window'),repo=f.app.projectWork.jevDecisions,sample=repo.read('project',thread.placement.inputsRef!)!;
  for(let index=1;index<=34;index++){const at=new Date(Date.parse(sample.at)+index).toISOString();repo.record({...sample,id:repo.id(at),at});}
  const calls=made.calls.length;expect(effect((await owner('rule_set',{set:{minEffort:'high'}})).text)).toContain('On the last 30 decisions it would have changed 30');expect(made.calls).toHaveLength(calls);expect((await f.app.projectWork.store.list('project'))).toHaveLength(1);
});

test('a proposed p-v1 replays five stored packets and preserves work while recording model-change evidence',async()=>{
  const made=await placementRuleFixture();f=made.f;const thread=await started(made,'history_replay'),repo=f.app.projectWork.jevDecisions,sample=repo.read('project',thread.placement.inputsRef!)!;
  for(let index=1;index<=4;index++){const at=new Date(Date.parse(sample.at)+index).toISOString();repo.record({...sample,id:repo.id(at),at});}
  const before=structuredClone(thread),calls=made.calls.length;made.choices.pick_model='large';made.choices.effort='high';
  const proposed=await owner('prompt_propose',{name:'p-v1',edits:[{find:'Choose the model that should carry this thread end to end.',replace:'Choose the model using this owned proposed prompt.'}],summary:'Owned five-source replay.'});
  expect(made.calls.length-calls).toBe(5);expect(proposed.text).toContain('Replay on the last 5 decisions that used p-v1: 5 would change.');expect(proposed.text.toLowerCase()).toContain('unavailable');
  for(const call of made.calls.slice(calls))expect(call.state).toEqual(JSON.parse(sample.inputs.state));
  const proposal=f.app.ownerJev.proposals().find(row=>row.id===proposed.text.match(/^P[1-9][0-9]*/u)![0])!;expect(proposal).toMatchObject({state:'proposed',replayReportId:expect.any(String)});
  expect(f.app.ownerJev.active('p-v1').version).toBe(1);expect(f.thread(thread.id)).toEqual(before);expect((await f.app.projectWork.store.list('project'))).toHaveLength(1);expect(made.first.runs).toHaveLength(1);expect(made.second.runs).toHaveLength(0);
});

test('prompt replay selects usable Jev answers beyond newer fallback records',async()=>{
  const made=await placementRuleFixture();f=made.f;const thread=await started(made,'history_selection'),repo=f.app.projectWork.jevDecisions,sample=repo.read('project',thread.placement.inputsRef!)!;
  for(let index=1;index<=30;index++){const at=new Date(Date.parse(sample.at)+index).toISOString();repo.record({...sample,id:repo.id(at),at,source:'fallback',calls:[]});}
  const calls=made.calls.length;made.choices.pick_model='large';made.choices.effort='high';const proposed=await owner('prompt_propose',{name:'p-v1',edits:[{find:'Choose the model that should carry this thread end to end.',replace:'Use the owned selection proposal.'}],summary:'Owned selection window.'});expect(made.calls.length-calls).toBe(1);expect(proposed.text).toContain('Replay on the last 1 decisions that used p-v1: 1 would change.');expect(made.first.runs).toHaveLength(1);expect(made.second.runs).toHaveLength(0);
});
