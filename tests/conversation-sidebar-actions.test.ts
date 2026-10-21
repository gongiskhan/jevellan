import {ownerConversationOperation} from '../apps/daemon/dist/owner-proxy.js';
import {join} from 'node:path';
import {writeFakeNativeSession} from '../packages/runtime-contract/dist/index.js';
import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
const rows=(ids:string[])=>ids.map(id=>({id}));
const drop=(ids:string[],order:string[],id:string,target:string,after:boolean)=>{const prepare=Reflect.get(core,'conversationSidebarDrop');expect(prepare).toBeTypeOf('function');return prepare(rows(ids),{...core.defaultSessionListPreferences(),revision:4,order},{schema:'conversation-sidebar-drop-v1',revision:4,id,target,after});};

test('conversation sidebar actions preserve before/after drops, optimistic preview and missing saved ids',()=>{
 expect(drop(['a','b','c'],['c','legacy'],'b','a',false)).toEqual({schema:'conversation-sidebar-drop-view-v1',previewOrder:['b','a','c'],request:{schema:'session-list-update-v1',revision:4,operation:'order',order:['b','a','c','legacy']}});expect(drop(['a','b','c'],['legacy'],'a','b',true).previewOrder).toEqual(['b','a','c']);expect(drop(['a','b','c'],['legacy'],'a','c',false).previewOrder).toEqual(['b','a','c']);
});

test('conversation sidebar actions preserve invalid/self drop no-ops and the 10000-entry saved-order cap',()=>{
 for(const [id,target] of [['a','a'],['missing','a'],['a','missing']])expect(drop(['a','b'],['legacy'],id!,target!,false).request).toBeNull();const ids=Array.from({length:10001},(_,i)=>'row_'+i);const view=drop(ids,['legacy'],'row_0','row_1',true);expect(view.previewOrder).toHaveLength(10001);expect(view.previewOrder.slice(0,3)).toEqual(['row_1','row_0','row_2']);if(!view.request)throw Error('A valid drop must prepare a saved order.');expect(view.request.order).toHaveLength(10000);expect(view.request.order).not.toContain('legacy');
});

test('conversation sidebar actions prepare native-only preference renames and guarded owner renames with exact blank policy',()=>{
 const prepare=Reflect.get(core,'conversationSidebarRename'),allowed=Reflect.get(core,'conversationSidebarCanRename');expect(prepare).toBeTypeOf('function');expect(allowed).toBeTypeOf('function');const preferences={...core.defaultSessionListPreferences(),revision:7};expect(allowed(' \n ')).toBe(false);expect(allowed(' title ')).toBe(true);
 expect(prepare({id:'native:owner:fixture',title:'Old native',cursor:true},' New native ','rename_native',preferences)).toEqual({schema:'conversation-sidebar-rename-view-v1',kind:'native',request:{schema:'session-list-update-v1',revision:7,operation:'rename',id:'native:owner:fixture',title:'New native'}});
 expect(prepare({id:'owner',title:'Old owner',cursor:false},' New owner ','rename_owner',preferences)).toEqual({schema:'conversation-sidebar-rename-view-v1',kind:'owner',path:'/api/conversations/owner/rename',request:{schema:'rename-conversation-v1',clientRequestId:'rename_owner',previousTitle:'Old owner',title:'New owner'}});expect(()=>prepare({id:'owner',title:'Old owner',cursor:false},' ','rename_owner',preferences)).toThrow();expect(()=>prepare({id:'owner',title:'Old owner',cursor:false},'x'.repeat(201),'rename_owner',preferences)).toThrow();
});

test('conversation sidebar actions order facade delegates canonical preferences and preserves revision/no-op guards',async()=>{
 f=await projectFixture();for(const id of ['a','b','c']){await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:id,message:'Wait for my next step.',clientMessageId:'start_'+id});await f.app.conversations.wait(id);}const current=await(await f.request('/api/conversation-list/sidebar')).json();const ids=current.allRows.map((row:{id:string})=>row.id);expect(ids).toHaveLength(3);await f.request('/api/session-list/view','POST',{schema:'session-list-update-v1',revision:0,operation:'order',order:['legacy']});
 const input={schema:'conversation-sidebar-drop-v1',revision:1,id:ids[0],target:ids[2],after:true};const response=await f.request('/api/conversation-list/order','POST',input);expect(response.status).toBe(200);const result=await response.json();expect(result).toMatchObject({schema:'conversation-sidebar-drop-result-v1',accepted:true,preferences:{revision:2,order:[ids[1],ids[2],ids[0],'legacy']},previewOrder:[ids[1],ids[2],ids[0]]});expect((await f.request('/api/conversation-list/order','POST',input)).status).toBe(409);const noop=await f.request('/api/conversation-list/order','POST',{...input,revision:2,id:'missing'});expect(noop.status).toBe(200);expect(await noop.json()).toMatchObject({accepted:false,preferences:{revision:2}});expect(f.fake.starts).toHaveLength(0);
});

test('conversation sidebar actions owner rename facade retains previous-title and idempotency guards',async()=>{
 f=await projectFixture();await f.app.conversations.create({schema:'start-conversation-v1',id:'owner',projectId:'project',title:'Original owner',message:'Wait for my next step.',clientMessageId:'start_owner'});await f.app.conversations.wait('owner');const input={schema:'conversation-sidebar-rename-request-v1',kind:'owner',id:'owner',previousTitle:'Original owner',title:' Renamed owner ',clientRequestId:'rename_owner'};const path='/api/conversation-list/rename',response=await f.request(path,'POST',input);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({conversation:{title:'Renamed owner'}});expect((await f.request(path,'POST',input)).status).toBe(200);expect((await f.request(path,'POST',{...input,clientRequestId:'stale_owner',title:'Stale title'})).status).toBe(409);expect((await f.app.conversations.view('owner')).conversation.title).toBe('Renamed owner');expect(f.fake.starts).toHaveLength(0);
});

test('conversation sidebar actions preserve authentication, strict mutation inputs and read-only method bounds',async()=>{
 f=await projectFixture();for(const path of ['/api/conversation-list/order','/api/conversation-list/rename']){expect((await fetch(f.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);expect((await f.request(path)).status).toBe(405);expect((await f.request(path,'POST',{schema:'unknown',extra:true})).status).toBe(400);}expect(f.fake.starts).toHaveLength(0);
});


test('conversation sidebar actions native rename facade keeps titles in canonical per-device preferences',async()=>{
 f=await projectFixture();writeFakeNativeSession({format:'claude',home:join(f.homes.userHome,'.claude'),sessionId:'sidebar-action-native',cwd:f.checkout,rows:[{role:'user',text:'Native original'},{role:'assistant',text:'Recorded fixture answer.'}],append:false});const view=await(await f.request('/api/conversation-list/sidebar')).json();expect(view.allRows).toHaveLength(1);const id=view.allRows[0].id,input={schema:'conversation-sidebar-rename-request-v1',kind:'native',id,revision:0,title:' Native renamed '};const response=await f.request('/api/conversation-list/rename','POST',input);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({schema:'session-list-view-v1',preferences:{revision:1,titles:{[id]:'Native renamed'}}});expect((await f.request('/api/conversation-list/rename','POST',input)).status).toBe(409);expect((await(await f.request('/api/conversation-list/sidebar')).json()).allRows[0].title).toBe('Native renamed');expect((await(await f.request('/api/cursor')).json()).sessions[0].title).toBe('Native original');expect(f.fake.starts).toHaveLength(0);
});


test('conversation sidebar actions keep member-owned renames on the indexed owner through HTTP and tools',async()=>{
 f=await projectFixture();const member=await projectMember(f);await member.app.conversations.create({schema:'start-conversation-v1',id:'member_sidebar',projectId:'project',title:'Member original',message:'Wait for my next step.',clientMessageId:'member_sidebar_start'});await member.app.conversations.wait('member_sidebar');await member.app.conversations.list();
 const request={schema:'conversation-sidebar-rename-request-v1',kind:'owner',id:'member_sidebar',previousTitle:'Member original',title:'Member HTTP rename',clientRequestId:'member_http_rename'};const response=await f.request('/api/conversation-list/rename','POST',request);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({conversation:{title:'Member HTTP rename',ownerDeviceId:member.deviceId}});
 expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_sidebar_rename',args:{project:'project',request:{...request,previousTitle:'Member HTTP rename',title:'Member tool rename',clientRequestId:'member_tool_rename'}}})).toMatchObject({ok:true,data:{conversation:{title:'Member tool rename',ownerDeviceId:member.deviceId}}});
 await expect(ownerConversationOperation(f.app,'another_project','member_sidebar','rename',{schema:'rename-conversation-v1',previousTitle:'Member tool rename',title:'Wrong project',clientRequestId:'wrong_project_rename'})).rejects.toThrow('another conversation or project');expect(f.app.conversations.hasLocalConversation('member_sidebar')).toBe(false);expect((await member.app.conversations.view('member_sidebar')).conversation.title).toBe('Member tool rename');expect(f.fake.starts).toHaveLength(0);expect(member.fake.starts).toHaveLength(0);
});

test('conversation sidebar actions member HTTP rename reuses the normal signed-in owner connection',async()=>{
 f=await projectFixture();const member=await projectMember(f);await f.app.conversations.create({schema:'start-conversation-v1',id:'hub_sidebar',projectId:'project',title:'Hub original',message:'Wait for my next step.',clientMessageId:'hub_sidebar_start'});await f.app.conversations.wait('hub_sidebar');await f.app.conversations.list();const response=await member.request('/api/conversation-list/rename','POST',{schema:'conversation-sidebar-rename-request-v1',kind:'owner',id:'hub_sidebar',previousTitle:'Hub original',title:'Renamed from member',clientRequestId:'member_to_hub_rename'});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({conversation:{ownerDeviceId:f.app.device.deviceId,title:'Renamed from member'}});expect(member.app.conversations.hasLocalConversation('hub_sidebar')).toBe(false);expect((await f.app.conversations.view('hub_sidebar')).conversation.title).toBe('Renamed from member');expect(f.fake.starts).toHaveLength(0);expect(member.fake.starts).toHaveLength(0);
});

test('conversation sidebar actions report an ignored drop as unchanged without claiming a save',async()=>{
 f=await projectFixture();const result=await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_sidebar_drop',args:{project:'project',request:{schema:'conversation-sidebar-drop-v1',revision:0,id:'missing',target:'another_missing',after:false}}});expect(result).toMatchObject({ok:true,text:'Session order unchanged.',data:{accepted:false,preferences:{revision:0}}});expect(await(await f.request('/api/session-list/view')).json()).toMatchObject({preferences:{revision:0,order:[]}});expect(f.fake.starts).toHaveLength(0);
});
