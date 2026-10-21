import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {git,type ProjectFixture} from './project-fixture.js';
type RecoveryFixture=Pick<ProjectFixture,'app'|'fake'|'checkout'>;

export function enqueueConversationHandoff(f:RecoveryFixture,file?:{name:string;content:string}){
 f.fake.enqueue(async({input})=>{
  if(file)writeFileSync(join(f.checkout,file.name),file.content);
  const response=await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`},body:JSON.stringify({schema:'bridge-request-v1',operation:'call',name:'jevellan_handoff',arguments:{schema:'handoff-v2',stretch:input.stretch,action:input.action,status:'done',summary:'The recovery fixture is recorded.',proposedNext:null,evidence:[],findings:[],blockers:[],failedApproaches:[],changedFiles:[]}})});
  assert.equal(response.status,200);return{status:'completed'};
 });
}
async function create(f:RecoveryFixture,id:string){f.fake.capabilities.readOnlyEnforced=true;await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'Recovery fixture',message:'Preserve the recovery fixture.',clientMessageId:`${id}_first`});await f.app.conversations.wait(id);}
async function manual(f:RecoveryFixture,id:string,action:'reply'|'implement'){await f.app.conversations.manual(id,{schema:'manual-step-v1',generation:(await f.app.conversations.view(id)).conversation.generation,action,modelId:'fixture',effort:'medium'});await f.app.conversations.wait(id);}

/** Simulated runtime violates its read-only reply contract; the normal writer records a reviewable checkpoint block. */
export async function blockedConversationReview(f:RecoveryFixture,id='recovery_editor'){
 await create(f,id);const head=git(f.checkout,'rev-parse','HEAD');enqueueConversationHandoff(f,{name:'reviewed.txt',content:'Review this fixture addition.\n'});await manual(f,id,'reply');
 const view=await f.app.conversations.view(id);assert.equal(view.conversation.state,'blocked');assert.equal(view.checkpointBlocks.length,1);assert.equal(git(f.checkout,'rev-parse','HEAD'),head);const changes=await f.app.conversations.changes(id,1);assert.ok(changes.recovery?.fingerprint);return{view,changes,head};
}

/** An owned disposable dirty file blocks normal undo; removing that exact fixture file makes a normal retry possible. */
export async function blockedConversationRedo(f:RecoveryFixture,id='redo_editor'){
 await create(f,id);const initial=git(f.checkout,'rev-parse','HEAD');enqueueConversationHandoff(f,{name:'redo-value.txt',content:'A checkpoint to undo.\n'});await manual(f,id,'implement');
 const checkpoint=git(f.checkout,'rev-parse','HEAD');assert.notEqual(checkpoint,initial);const outside=join(f.checkout,'redo-dirty.txt');writeFileSync(outside,'Preserve this fixture until undo is blocked.\n');
 await f.app.conversations.correct(id,{schema:'correct-step-v1',clientRequestId:`${id}_correction`,generation:(await f.app.conversations.view(id)).conversation.generation,stretch:1,mode:'redo',choices:{action:'reply'}});await f.app.conversations.wait(id);const view=await f.app.conversations.view(id);assert.equal(view.redos.at(-1)?.status,'blocked');assert.equal(git(f.checkout,'rev-parse','HEAD'),checkpoint);unlinkSync(outside);return{view,initial,checkpoint,entry:view.redos.at(-1)!};
}

/** Holds one owned Fake turn so admission tests exercise a genuinely running step. Abort always releases the wait. */
export function enqueueHeldConversationHandoff(f:RecoveryFixture){
 let enteredResolve!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enteredResolve=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 f.fake.enqueue(async({input,signal})=>{
  enteredResolve();await new Promise<void>(resolve=>{const abort=()=>{signal.removeEventListener('abort',abort);resolve();};signal.addEventListener('abort',abort,{once:true});void held.then(()=>{signal.removeEventListener('abort',abort);resolve();});if(signal.aborted)abort();});
  if(signal.aborted)return{status:'interrupted'};
  const response=await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`},body:JSON.stringify({schema:'bridge-request-v1',operation:'call',name:'jevellan_handoff',arguments:{schema:'handoff-v2',stretch:input.stretch,action:input.action,status:'done',summary:'The held manual fixture is recorded.',proposedNext:null,evidence:[],findings:[],blockers:[],failedApproaches:[],changedFiles:[]}})});
  assert.equal(response.status,200);return{status:'completed'};
 });
 return{entered,release};
}
