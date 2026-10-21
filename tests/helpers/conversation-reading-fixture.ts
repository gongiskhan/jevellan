import assert from 'node:assert/strict';
import type {Effort} from '../../packages/core/dist/index.js';
import {projectFixture} from './project-fixture.js';

/** One owned Fake turn with real tool events and a canonical recorded answer; all provider work is simulated. */
export async function conversationReadingFixture(control=false,usage?:{inputTokens:number;outputTokens:number;costUsd:number},effort:Effort='high'){
 const f=await projectFixture({control}),id='reading_fixture';let enteredResolve!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enteredResolve=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 try{
  f.fake.capabilities.readOnlyEnforced=true;
  await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'Reading fixture',message:'Explain the fixture value.',clientMessageId:'reading_first'});await f.app.conversations.wait(id);
  f.fake.enqueue(async({input,emit,signal})=>{
   emit({type:'text',delta:'Inspecting the fixture.'});emit({type:'tool-start',id:'reading_tool',name:'Read fixture',input:{path:'value.txt'}});enteredResolve();
   await new Promise<void>(resolve=>{const abort=()=>{signal.removeEventListener('abort',abort);resolve();};signal.addEventListener('abort',abort,{once:true});void held.then(()=>{signal.removeEventListener('abort',abort);resolve();});if(signal.aborted)abort();});
   if(signal.aborted)return{status:'interrupted'};
   if(usage)emit({type:'usage',...usage});
   emit({type:'tool-end',id:'reading_tool',ok:true,output:'The fixture value is one.'});emit({type:'text',delta:'The fixture result is saved.'});
   const response=await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`},body:JSON.stringify({schema:'bridge-request-v1',operation:'call',name:'jevellan_handoff',arguments:{schema:'handoff-v2',stretch:input.stretch,action:input.action,status:'done',summary:'The fixture result is saved.',result:{type:'answer',content:'# Recorded reading result\n\nThe fixture result is saved.'},evidence:[{kind:'file',ref:'value.txt',note:'The fixture input.'},{kind:'command',ref:'Read fixture value'}],findings:[{claim:'The fixture value is one.',pointer:'value.txt'}],blockers:['Review the fixture finding.'],question:'Which fixture value should stay?',options:[{label:'Keep the fixture'},{label:'Change the fixture'}],failedApproaches:[],proposedNext:null,changedFiles:[]}})});
   assert.equal(response.status,200);return{status:'completed'};
  });
  await f.app.conversations.manual(id,{schema:'manual-step-v1',generation:(await f.app.conversations.view(id)).conversation.generation,action:'reply',modelId:'fixture',effort});await entered;
  return{f,id,release,finish:async()=>{release();await f.app.conversations.wait(id);return f.app.conversations.view(id);}};
 }catch(error){release();await f.close();throw error;}
}
