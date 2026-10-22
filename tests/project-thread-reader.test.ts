import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {forThread} from '../packages/runtime-contract/dist/index.js';
import {projectFixture,projectMember,reportStep,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
const request=(patch:Record<string,unknown>={})=>({schema:'project-thread-reader-request-v1',projectId:'project',threadId:'thread_fixture',...patch});
const facts=(state='idle',patch:Record<string,unknown>={})=>({schema:'project-thread-read-facts-v1',projectId:'project',threadId:'thread_fixture',state,...patch});
async function setup(){f=await projectFixture({control:true});f.fake.enqueueTurn(reportStep({status:'progress',summary:'Recorded reader fixture.'}),forThread());const made=await f.json('/api/projects/project/threads',core.ThreadCreatedViewSchema,'POST',{schema:'thread-create-request-v1',clientRequestId:'thread_reader_fixture',title:'Thread reader fixture',task:'Inspect the simulated read policy.'});await f.waitFor(()=>f!.thread(made.threadId),row=>row.state==='idle');return{f,id:made.threadId,path:`/api/projects/project/threads/${made.threadId}`};}

test('thread reader coalesces repeated concurrent requests into exactly one followup',()=>{
 const reader=core.projectThreadReader(request(),()=>0);expect(reader.begin()).toBe(true);for(let i=0;i<9;i++)expect(reader.begin()).toBe(false);expect(reader.complete()).toMatchObject({schema:'project-thread-read-completion-v1',readAgain:true,pollHintMs:10000});expect(reader.begin()).toBe(true);expect(reader.complete()).toMatchObject({readAgain:false,pollHintMs:10000});
});
test('thread reader keeps the original six-second after-action boundary and live versus rest cadence',()=>{
 let now=0;const reader=core.projectThreadReader(request(),()=>now);expect(reader.accepted(facts())).toMatchObject({refreshSidebar:false});reader.action();now=5999;expect(reader.complete().pollHintMs).toBe(1500);now=6000;expect(reader.complete().pollHintMs).toBe(10000);expect(reader.accepted(facts('running'))).toMatchObject({refreshSidebar:true});expect(reader.complete().pollHintMs).toBe(1500);expect(reader.accepted(facts('running'))).toMatchObject({refreshSidebar:false});expect(reader.accepted(facts('done'))).toMatchObject({refreshSidebar:true});expect(reader.complete().pollHintMs).toBe(10000);
});
test('thread reader applies canonical hints and takes a defensive policy snapshot',()=>{
 const policy={...core.THREAD_READ_POLICY,liveMs:1700,restMs:11000,afterActionMs:7000};const hint=core.threadReadHint('idle',0,0,policy),reader=core.projectThreadReader(request(),()=>0);reader.accepted(facts('idle',{readHint:hint}));hint.policy.restMs=99;expect(reader.complete().pollHintMs).toBe(11000);reader.action();expect(reader.complete().pollHintMs).toBe(1700);expect(core.THREAD_READ_POLICY.restMs).toBe(10000);
});
test('thread reader rejects foreign accepted facts extra fields and a hint inconsistent with canonical state',()=>{
 expect(core.ProjectThreadReaderRequestSchema).toBeDefined();expect(()=>core.ProjectThreadReaderRequestSchema.parse({...request(),path:'/arbitrary'})).toThrow();const reader=core.projectThreadReader(request(),()=>0);reader.accepted(facts());expect(()=>reader.accepted(facts('running',{projectId:'other'}))).toThrow();expect(()=>reader.accepted(facts('running',{threadId:'other_thread'}))).toThrow();expect(()=>reader.accepted({...facts(),extra:true})).toThrow();expect(()=>reader.accepted(facts('running',{readHint:core.threadReadHint('idle',0)}))).toThrow();expect(reader.complete().pollHintMs).toBe(10000);
});
test('thread reader instances stay independent across effect cleanup and restore only matching initial facts',()=>{
 const old=core.projectThreadReader(request(),()=>0),current=core.projectThreadReader(request(),()=>0);expect(old.begin()).toBe(true);expect(old.begin()).toBe(false);expect(current.begin()).toBe(true);expect(old.complete().readAgain).toBe(true);expect(current.complete().readAgain).toBe(false);const seeded=core.projectThreadReader(request({initial:facts('running')}),()=>0);expect(seeded.accepted(facts('idle')).refreshSidebar).toBe(true);const foreign=core.projectThreadReader(request({initial:facts('running',{threadId:'other_thread'})}),()=>0);expect(foreign.accepted(facts('idle')).refreshSidebar).toBe(false);
});
test('thread reader refreshes sidebar counts for every action response without changing read semantics',()=>{
 const reader=core.projectThreadReader(request(),()=>0);expect(reader.accepted(facts())).toMatchObject({refreshSidebar:false});expect(reader.accepted(facts('idle',{cause:'action'}))).toMatchObject({refreshSidebar:true});expect(reader.accepted(facts())).toMatchObject({refreshSidebar:false});expect(reader.accepted(facts('running',{cause:'action'}))).toMatchObject({refreshSidebar:true});
});
test('thread reader keeps the explicit starting hint while failure classification remains separate',()=>{
 const reader=core.projectThreadReader(request(),()=>10000);reader.accepted(facts('done'));expect(reader.complete({schema:'project-thread-read-completion-request-v1',starting:true})).toMatchObject({pollHintMs:1500});expect(reader.complete()).toMatchObject({pollHintMs:10000});expect(()=>reader.complete({schema:'project-thread-read-completion-request-v1',starting:true,extra:true})).toThrow();
});
test('normal thread views and owner reads share hints while older views remain compatible without writes',async()=>{
 const made=await setup(),before=structuredClone(made.f.thread(made.id)),response=await made.f.request(made.path);expect(response.status).toBe(200);const value=await response.json();expect(value).toMatchObject({readHint:{schema:'project-thread-read-hint-v1',pollHintMs:10000,policy:{schema:'project-thread-read-policy-v1',liveMs:1500,restMs:10000,afterActionMs:6000}}});expect(await made.f.app.ownerTools.call('thread',{schema:'owner-tool-request-v1',caller:'cli',action:'view',args:{project:'project',thread:made.id}})).toMatchObject({ok:true,data:{readHint:value.readHint}});const older={...value};delete older.readHint;expect(core.ThreadViewSchema.safeParse(older).success).toBe(true);expect(core.ThreadViewSchema.safeParse({...value,readHint:{...value.readHint,extra:true}}).success).toBe(false);expect(made.f.thread(made.id)).toEqual(before);expect(made.f.fake.turnStarts).toHaveLength(1);
});
test('member thread reads preserve the owner hint and live cadence without starting another turn',async()=>{
 const made=await setup(),member=await projectMember(made.f);made.f.app.projectWork.store.update(made.id,row=>({...row,state:'running'}));const before=structuredClone(made.f.thread(made.id));const response=await member.request(made.path);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({readHint:{schema:'project-thread-read-hint-v1',pollHintMs:1500}});expect(made.f.thread(made.id)).toEqual(before);expect(made.f.fake.turnStarts).toHaveLength(1);expect(member.fake.turnStarts).toHaveLength(0);
});
