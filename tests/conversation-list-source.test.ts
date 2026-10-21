import {afterEach,expect,test,vi} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,type ProjectFixture} from './helpers/project-fixture.js';
import {conversationPlanReviewFixture} from './helpers/conversation-plan-review-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('conversation list source refresh skips concurrent requests without discarding its completed read',async()=>{
 const create=Reflect.get(core,'conversationListRefresh');expect(create).toBeTypeOf('function');expect(Reflect.get(core,'CONVERSATION_LIST_POLL_MS')).toBe(5000);expect(Reflect.get(core,'CONVERSATION_UPDATED_EVENT')).toBe('jevellan-conversation-updated');
 const first=deferred<string>(),read=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('next'),receive=vi.fn(),failed=vi.fn();const refresh=create(read,receive,failed),pending=refresh.request();await refresh.request();await refresh.request();expect(read).toHaveBeenCalledOnce();first.resolve('initial');await pending;expect(receive.mock.calls).toEqual([['initial']]);expect(read).toHaveBeenCalledOnce();await refresh.request();expect(receive.mock.calls).toEqual([['initial'],['next']]);refresh.stop();expect(failed).not.toHaveBeenCalled();
});

test('conversation list source refresh aborts late results and recovers after failure',async()=>{
 const create=Reflect.get(core,'conversationListRefresh');expect(create).toBeTypeOf('function');const late=deferred<string>(),receive=vi.fn(),failed=vi.fn(),error=new Error('Temporary source failure');const read=vi.fn().mockRejectedValueOnce(error).mockReturnValueOnce(late.promise),refresh=create(read,receive,failed);await refresh.request();expect(failed).toHaveBeenCalledWith(error);const pending=refresh.request();const signal=read.mock.calls[1]![0] as AbortSignal;refresh.stop();expect(signal.aborted).toBe(true);late.resolve('after navigation');await pending;await refresh.request();expect(read).toHaveBeenCalledTimes(2);expect(receive).not.toHaveBeenCalled();
});

test('conversation list source update keys track only conversation id, state and title',()=>{
 const key=Reflect.get(core,'conversationListUpdateKey');expect(key).toBeTypeOf('function');expect(key(undefined)).toBeNull();const source={id:'owner',state:'idle' as const,title:'A recorded title'},withExtra={...source,generation:2};expect(key(source)).toBe(key(withExtra));expect(key({...source,title:'Renamed'})).not.toBe(key(source));expect(key({...source,state:'running'})).not.toBe(key(source));expect(key({...source,id:'another'})).not.toBe(key(source));
});

test('conversation list source HTTP and owner tool share existing owner/project reads without extra work',async()=>{
 const made=await conversationPlanReviewFixture();f=made.f;const starts=f.fake.starts.length,count=f.app.conversations.ledger(made.id).events().length;
 const response=await f.request('/api/conversation-list/view');expect(response.status).toBe(200);const view=await response.json();expect(view).toMatchObject({schema:'conversation-list-source-v1',deviceId:f.app.device.deviceId,readPolicy:{schema:'conversation-list-read-policy-v1',pollMs:5000,updatedEvent:'jevellan-conversation-updated'}});
 const ordinary=await(await f.request('/api/conversations')).json(),projects=await(await f.request('/hub/projects')).json();expect(view.conversations).toEqual(ordinary.conversations);expect(view.projects).toEqual(projects.projects.map((row:{project:{id:string;name:string}})=>({id:row.project.id,name:row.project.name})));expect(view.projects[0]).not.toHaveProperty('paths');
 const result=await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_list',args:{project:'project'}});expect(result).toMatchObject({ok:true,data:view});expect(f.fake.starts).toHaveLength(starts);expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);
});

test('conversation list source preserves owner authentication, strict query and the conversation named view',async()=>{
 const fixture=f=await projectFixture();await fixture.app.conversations.create({schema:'start-conversation-v1',id:'view',projectId:'project',title:'A conversation named view',message:'Wait for my next step.',clientMessageId:'first_view'});await fixture.app.conversations.wait('view');expect((await fixture.request('/api/conversations/view')).status).toBe(200);
 const path='/api/conversation-list/view';expect((await fetch(fixture.base+path)).status).toBe(401);expect((await fixture.request(path+'?extra=true')).status).toBe(400);expect((await fixture.request(path,'POST',{})).status).toBe(405);expect((await fixture.request('/api/conversations/view')).status).toBe(200);expect(fixture.fake.starts).toHaveLength(0);
});
