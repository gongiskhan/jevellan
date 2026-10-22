import type {ProjectLedger} from '../../packages/projects/dist/index.js';
import {taskInteractionFixture} from './task-interaction-fixture.js';

/** Durable isolated fixture records; provider work remains simulated and paused. */
export function seedProjectChat(work:{coordinatorLedger(projectId:string):ProjectLedger},taskIds:string[],options:{summary?:string;reply?:string}={}){
 const ledger=work.coordinatorLedger('project'),at=new Date().toISOString();
 const owner=ledger.append({type:'coordinator-event',data:{schema:'coordinator-event-v1',kind:'user-message',id:'cev_chat_fixture',at,text:'A recorded fixture request.',clientMessageId:'chat_fixture_owner',via:'CLI'}});
 ledger.append({type:'coordinator-turn-start',turn:1,data:{schema:'coordinator-turn-v1',turn:1,fresh:false,runtime:'fake',modelLabel:'Fixture',effort:'high',accountLabel:'Fixture',eventIds:['cev_chat_fixture']}});
 const tool={schema:'coordinator-tool-v1',tool:'jevellan_task_create',ok:true,summary:options.summary??'Two recorded tasks.',taskIds};
 const routed=ledger.append({type:'coordinator-tool',turn:1,data:tool});ledger.append({type:'coordinator-tool',turn:1,data:tool});
 const reply=ledger.append({type:'coordinator-text',turn:1,data:{schema:'coordinator-text-v1',text:options.reply??'Two recorded fixture tasks.'}});
 ledger.append({type:'coordinator-turn-end',turn:1,data:{schema:'coordinator-turn-end-v1',turn:1,status:'completed'}});
 const marker='A synthetic chat read-time marker.',notice=ledger.append({type:'notice',data:{schema:'project-notice-v1',kind:'info',text:marker}});
 return{ledger,owner,routed,reply,notice,marker};
}
export async function projectChatFixture(control=false){const made=await taskInteractionFixture(control);try{return{...made,...seedProjectChat(made.work,[made.proposed.id,made.queued.id])};}catch(error){await made.f.close();throw error;}}
