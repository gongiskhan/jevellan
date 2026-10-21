import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
const project=(id:string,paths:Record<string,string>,allowedDevices?:string[])=>core.ProjectSchema.parse({schema:'project-v1',id,name:id,paths,allowedDevices,branchPolicy:'main',memory:{mode:'repo',dir:'.jevellan/memory'},context:{state:'none'}});
const source=(projects=[project('ready',{here:'/fixture/project'})],accountCount=1,jevSaved=false)=>{const prepare=Reflect.get(core,'conversationNewSource');expect(prepare).toBeTypeOf('function');return prepare({schema:'conversation-new-facts-v1',projects,device:{id:'here',name:'This device'},accountCount,jevSaved});};
const view=(data=source(),request:Record<string,unknown>={})=>{const prepare=Reflect.get(core,'conversationNewView');expect(prepare).toBeTypeOf('function');return prepare(data,{schema:'conversation-new-request-v1',...request});};

test('conversation new view preserves first-project selection, local path/allowlist availability and fixed device options',()=>{
 const data=source([project('first',{here:'/fixture/first'},['away']),project('ready',{here:'/fixture/ready'}),project('elsewhere',{away:'/fixture/elsewhere'})]);expect(data).toMatchObject({schema:'conversation-new-source-v1',defaultProjectId:'first',projects:[{id:'first',available:false},{id:'ready',available:true},{id:'elsewhere',available:false}]});const initial=view(data,{message:'A task'});expect(initial).toMatchObject({selectedProjectId:'first',canStart:false,deviceOptions:[{value:'here',label:'This device: This device',disabled:false},{value:'automatic',label:'Choose automatically',disabled:true}]});expect(initial.unavailableNotice).toContain('first isn’t set up on This device');expect(view(data,{projectId:'ready',message:'A task'}).canStart).toBe(true);expect(view(data,{projectId:'missing',message:'A task'}).canStart).toBe(false);
});

test('conversation new view preserves account/Jev notices and exact busy/message/resource Start gating',()=>{
 const noAccount=view(source(undefined,0,false),{message:'A task'});expect(noAccount.canStart).toBe(false);expect(noAccount.notices.map((n:{kind:string})=>n.kind)).toEqual(['account','jev']);const manual=view(source(),{message:'A task'});expect(manual.canStart).toBe(true);expect(manual.notices.map((n:{kind:string})=>n.kind)).toEqual(['jev']);expect(view(source(undefined,1,true),{message:'A task'}).notices).toEqual([]);expect(view(source(),{message:' \n '}).canStart).toBe(false);expect(view(source(),{message:'A task',busy:true}).canStart).toBe(false);expect(view(source([]),{message:'A task'})).toMatchObject({selectedProjectId:'',canStart:false,projectPlaceholder:'Add a project first'});
});

test('conversation new view selects the first added id and keeps an explicit selection when no id was added',()=>{
 const data=source([project('old',{here:'/fixture/old'}),project('second',{here:'/fixture/second'}),project('third',{here:'/fixture/third'})]);expect(view(data,{projectId:'old',previousProjectIds:['old']}).addedProjectId).toBe('second');expect(view(data,{projectId:'old',previousProjectIds:['old','second','third']})).toMatchObject({selectedProjectId:'old'});expect(view(data,{previousProjectIds:['old','second','third']}).addedProjectId).toBeUndefined();expect(view(source([]),{projectId:'removed'}).selectedProjectId).toBe('removed');
});

test('conversation new view validates versioned facts, source and request documents strictly',()=>{
 const facts=Reflect.get(core,'ConversationNewFactsSchema'),received=Reflect.get(core,'ConversationNewSourceSchema'),request=Reflect.get(core,'ConversationNewRequestSchema');expect(facts).toBeDefined();expect(received).toBeDefined();expect(request).toBeDefined();expect(()=>facts.parse({schema:'old',extra:true})).toThrow();expect(()=>received.parse({...source(),extra:true})).toThrow();expect(()=>request.parse({schema:'conversation-new-request-v1',extra:true})).toThrow();
});

test('conversation new view normal source, HTTP and tool reuse canonical project/account/Jev readers without starting work',async()=>{
 f=await projectFixture();const response=await f.request('/api/conversation-new/source');expect(response.status).toBe(200);const data=await response.json(),accounts=await(await f.request('/hub/accounts')).json(),workspace=await(await f.request('/api/config/workspace')).json();expect(data).toMatchObject({schema:'conversation-new-source-v1',device:{id:f.app.device.deviceId,name:f.app.device.name},defaultProjectId:'project',projects:[{id:'project',name:'Shop',available:true}],accountCount:accounts.accounts.length,jevSaved:workspace.jev.saved});expect(data.projects[0]).not.toHaveProperty('paths');const request={schema:'conversation-new-request-v1',projectId:'project',message:'A simulated draft'};const normal=await f.request('/api/conversation-new/view','POST',request);expect(normal.status).toBe(200);const prepared=await normal.json();expect(prepared).toMatchObject({schema:'conversation-new-view-v1',canStart:true,selectedProjectId:'project'});expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_new',args:{project:'project',request}})).toMatchObject({ok:true,data:prepared});expect(f.fake.starts).toHaveLength(0);
});

test('conversation new view keeps member UI and headless availability on the initiating device',async()=>{
 f=await projectFixture();const member=await projectMember(f),request={schema:'conversation-new-request-v1',projectId:'project',message:'A member draft'};const response=await member.request('/api/conversation-new/view','POST',request);expect(response.status).toBe(200);const prepared=await response.json();expect(prepared).toMatchObject({source:{device:{id:member.deviceId,name:member.name}},canStart:true});expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',deviceId:member.deviceId,action:'conversation_new',args:{project:'project',request}})).toMatchObject({ok:true,data:prepared});expect(f.fake.starts).toHaveLength(0);expect(member.fake.starts).toHaveLength(0);
});

test('conversation new view preserves authentication, strict source/query/input and method boundaries',async()=>{
 f=await projectFixture();expect((await fetch(f.base+'/api/conversation-new/source')).status).toBe(401);expect((await f.request('/api/conversation-new/source?extra=true')).status).toBe(400);expect((await f.request('/api/conversation-new/source','POST',{})).status).toBe(405);expect((await f.request('/api/conversation-new/view')).status).toBe(405);expect((await f.request('/api/conversation-new/view','POST',{schema:'conversation-new-request-v1',extra:true})).status).toBe(400);expect(f.fake.starts).toHaveLength(0);
});
