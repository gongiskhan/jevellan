import { afterEach, expect, test } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { conversationPlanReviewFixture } from './helpers/conversation-plan-review-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async()=>{await f?.close();f=undefined;});
const query=(value:unknown)=>`statusView=${encodeURIComponent(JSON.stringify(value))}`;
async function statusFrame(response:Response):Promise<unknown>{
 const reader=response.body!.getReader(),decoder=new TextDecoder();let text='';let timer:ReturnType<typeof setTimeout>|undefined;
 const read=async()=>{for(;;){const part=await reader.read();if(part.done)throw Error('Status stream ended early.');text+=decoder.decode(part.value,{stream:true});for(let end=text.indexOf('\n\n');end>=0;end=text.indexOf('\n\n')){const block=text.slice(0,end);text=text.slice(end+2);if(block.startsWith('event: status-view\n'))return JSON.parse(block.slice('event: status-view\ndata: '.length)) as unknown;}}};
 try{return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('No status view was pushed.')),3000);})]);}finally{clearTimeout(timer);await reader.cancel();}
}

test('the normal project stream pushes the canonical page view and the explicit tool uses the same reader',async()=>{
 const fixture=f=await projectFixture();const page={schema:'project-page-request-v1',resolvedDays:28,timeZone:'UTC',locale:'en',ackKnown:['known']};
 const response=await fixture.request(`/api/projects/project/coordinator/events?${query({schema:'project-status-stream-request-v1',page})}`);expect(response.status).toBe(200);
 const next=statusFrame(response);fixture.app.projectWork.coordinatorLedger('project').append({type:'notice',data:{schema:'project-notice-v1',text:'A simulated status update.',kind:'info'}});
 const value=await next;expect(value).toMatchObject({schema:'project-status-event-v1',request:page,view:{schema:'project-page-view-v1',work:{project:{id:'project'}}}});
 const parsed=(Reflect.get(core,'ProjectStatusEventSchema')).parse(value);const ordinary=await (await fixture.request('/api/projects/project/status-view','POST',page)).json();expect(parsed.view.changeToken).toBe(ordinary.changeToken);expect(parsed.view.overview).toEqual(ordinary.overview);
 const result=await fixture.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'project_page',args:{project:'project',request:page}});expect(result).toMatchObject({ok:true,data:{schema:'project-page-view-v1',changeToken:ordinary.changeToken}});expect(fixture.fake.starts).toHaveLength(0);
});

test('the owner conversation stream pushes the same canonical view as HTTP and the existing owner tool',async()=>{
 const made=await conversationPlanReviewFixture();const fixture=f=made.f, starts=fixture.fake.starts.length;
 const response=await fixture.request(`/api/conversations/${made.id}/events?${query({schema:'conversation-status-stream-request-v1'})}`);expect(response.status).toBe(200);
 const next=statusFrame(response);fixture.app.conversations.ledger(made.id).append({type:'notice',data:{schema:'conversation-notice-v1',kind:'info',text:'A simulated status update.'}});
 const value=await next;expect(value).toMatchObject({schema:'conversation-status-event-v1',view:{schema:'conversation-view-v1',conversation:{id:made.id}}});
 const parsed=Reflect.get(core,'ConversationStatusEventSchema').parse(value),ordinary=await (await fixture.request(`/api/conversations/${made.id}`)).json();expect(parsed.view).toEqual(ordinary);
 const result=await fixture.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_view',args:{project:'project',conversation:made.id}});expect(result).toMatchObject({ok:true,data:ordinary});expect(fixture.fake.starts).toHaveLength(starts);
});

test('status stream opt-ins reject extra fields before headers and retain normal session authentication',async()=>{
 const fixture=f=await projectFixture();
 const path=`/api/projects/project/coordinator/events?${query({schema:'project-status-stream-request-v1',page:{schema:'project-page-request-v1'},extra:true})}`;
 const denied=await fetch(fixture.base+path);expect(denied.status).toBe(401);
 const invalid=await fixture.request(path);await invalid.body?.cancel();expect(invalid.status).toBe(400);expect(fixture.fake.starts).toHaveLength(0);
});
