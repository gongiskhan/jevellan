import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import type {CoordinatorEvent,ProjectLedgerEvent} from '../packages/core/dist/index.js';
import {task,thread,at,sha} from './helpers/owner-fixtures.js';
import {projectChatFixture,seedProjectChat} from './helpers/project-chat-fixture.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
function policy(){const items=Reflect.get(core,'chatItems'),view=Reflect.get(core,'projectChatView'),groups=Reflect.get(core,'chatProposalGroups');for(const fn of[items,view,groups])expect(fn).toBeTypeOf('function');return{items,view,groups};}
const event=(type:ProjectLedgerEvent['type'],data:unknown,id:number,turn?:number):ProjectLedgerEvent=>({schema:'project-ledger-event-v1',id,t:at(1),type,data,...(turn?{turn}:{})});
const coordinator=(body:Record<string,unknown>,id=1)=>event('coordinator-event',{schema:'coordinator-event-v1',id:`cev_${id}`,at:at(1),...body},id);
const request=(patch:Record<string,unknown>={})=>({schema:'project-chat-view-request-v1',...patch});
const source=(events:ProjectLedgerEvent[])=>({schema:'project-chat-source-v1',projectId:'project',deviceId:'device_fixture',head:events.at(-1)?.id??0,threads:[],events});

test('project chat policy shares owner headings delivery reordered cards and remaining sibling proposals',()=>{
 const p=policy(),events=[coordinator({kind:'user-message',text:'A fixture request.',clientMessageId:'msg_fixture',via:'CLI'}),event('coordinator-tool',{schema:'coordinator-tool-v1',tool:'jevellan_task_create',ok:true,summary:'Two tasks.',taskIds:['one','two']},2,1),event('coordinator-tool',{schema:'coordinator-tool-v1',tool:'jevellan_task_create',ok:true,summary:'Retried.',taskIds:['one','two']},3,1),event('coordinator-text',{schema:'coordinator-text-v1',text:'Two fixture tasks.'},4,1),event('coordinator-turn-start',{schema:'coordinator-turn-v1',turn:1,fresh:false,runtime:'fake',modelLabel:'Fixture',effort:'high',accountLabel:'Fixture',eventIds:['cev_1']},5,1)],before=structuredClone(events),items=p.items(events);
 expect(items.map((row:{kind:string})=>row.kind)).toEqual(['owner','reply','routed']);expect(items[0]).toMatchObject({kind:'owner',heading:'You, via CLI',delivered:true});expect(items[2]).toMatchObject({id:2,taskIds:['one','two']});expect(p.groups(items,[{id:'one',state:'active'},{id:'two',state:'draft'}]).get(2)).toEqual(['two']);expect(events).toEqual(before);
});

test('project chat view pages display offsets under a frozen head instead of reordered numeric ids',()=>{
 const p=policy(),events=[event('coordinator-tool',{schema:'coordinator-tool-v1',tool:'jevellan_task_create',ok:true,summary:'Fixture task.',taskIds:['one']},1,1),event('coordinator-text',{schema:'coordinator-text-v1',text:'A reply before its card.'},2,1),event('notice',{schema:'project-notice-v1',kind:'info',text:'After the card.'},3)],initial=p.view(source(events),request({limit:1}));
 expect(initial).toMatchObject({schema:'project-chat-view-v1',projectId:'project',deviceId:'device_fixture',head:3,request:{offset:0,limit:1,throughEventId:3,deviceId:'device_fixture'},total:3,items:[{kind:'reply',id:2}],nextOffset:1,hasMore:true});
 const next=p.view(source([...events,event('coordinator-text',{schema:'coordinator-text-v1',text:'Later work.'},4)]),{...initial.request,offset:initial.nextOffset});expect(next).toMatchObject({head:4,total:3,items:[{kind:'routed',id:1}],nextOffset:2,hasMore:true});expect(p.view(source(events),{...initial.request,offset:2})).toMatchObject({items:[{kind:'notice',id:3}],nextOffset:null,hasMore:false});
});

test('project chat view rejects extra history ahead cursors wrong devices and out of range offsets',()=>{
 const p=policy(),input=source([event('notice',{schema:'project-notice-v1',kind:'info',text:'One fixture notice.'},1)]);for(const patch of[{events:[]},{limit:101},{throughEventId:2},{deviceId:'other_device'},{offset:2}])expect(()=>p.view(input,request(patch))).toThrow();const empty=p.view(source([]),request());expect(empty).toMatchObject({total:0,items:[],nextOffset:null,hasMore:false,request:{throughEventId:0}});const schema=Reflect.get(core,'ProjectChatViewSchema');expect(schema).toHaveProperty('parse');expect(()=>schema.parse({...empty,extra:true})).toThrow();expect(()=>schema.parse({...empty,deviceId:'other_device'})).toThrow();
});

test('project chat policy skips malformed records and retains last duplicate thread titles',()=>{
 const p=policy(),events=[coordinator({kind:'thread-resolved',threadId:'linked',by:'owner'}),event('coordinator-event',{schema:'coordinator-event-v1',kind:'user-message'},2),event('coordinator-text',{schema:'coordinator-text-v1',text:''},3)],input={...source(events),threads:[thread('linked','First title',{projectId:'project'}),thread('linked','Last title',{projectId:'project'})]};expect(p.view(input,request()).items).toEqual([{kind:'event',id:1,text:'Resolved "Last title"',threadId:'linked',delivered:false}]);
});

const expanded:Array<{body:Record<string,unknown>;text:string;detail?:string}>=[
 {body:{kind:'handoff-requested',reason:'nightly'},text:'Coordinator saved its work',detail:'Saving what is in flight before the next session.'},
 {body:{kind:'setup-requested'},text:'Setup recommendations requested'},
 {body:{kind:'settings-changed',by:'owner',changes:[]},text:'Project settings changed'},
 {body:{kind:'thread-resolved',threadId:'linked',by:'owner'},text:'Resolved "Fixture title"'},
 {body:{kind:'thread-placement-changed',threadId:'linked',reason:'escalation',summary:'Changed fixture placement.'},text:'Changed fixture placement.'},
 {body:{kind:'thread-auto-fix',threadId:'linked',prNumber:7,fixKind:'checks',round:1,maxRounds:2,outcome:'fixed'},text:'Pull request #7: automatic fix fixed'},
 {body:{kind:'memory-dreamed',summary:'Fixture memory summary.',counts:{inboxPromoted:0,inboxDropped:0,merged:0,corrected:0,archived:0,created:0}},text:'Memory dream completed',detail:'Fixture memory summary.'},
 {body:{kind:'deploy',deployId:'deploy_fixture',commit:sha('a'),threads:2,outcome:'deployed',summary:'Simulated outcome only.'},text:'Deployed aaaaaaa with 2 threads',detail:'Simulated outcome only.'},
 {body:{kind:'job-finished',jobId:'job_fixture',runId:'run_fixture',taskId:'task_fixture',name:'Fixture job',conclusion:'passed',commit:sha('a'),summary:'Fixture job summary.'},text:'Job "Fixture job" passed',detail:'aaaaaaa · Fixture job summary.'},
 {body:{kind:'project-reviewed',report:{schema:'project-review-report-v1',projectId:'project',taskId:'task_fixture',fromCommit:null,commit:sha('a'),reviewedAt:at(1),runtime:'fake',model:'Fixture',summary:'Fixture review summary.',findings:[]}},text:'Nightly review completed',detail:'Fixture review summary.'},
 {body:{kind:'window-opened',pending:2},text:'Nightly window opened',detail:'2 nightly tasks pending. Merges are held.'},
 {body:{kind:'window-finished',outcome:'Fixture window complete.'},text:'Nightly window finished',detail:'Fixture window complete.'},
 {body:{kind:'goal-refill',goals:[{goalId:'goal_fixture',name:'Fixture goal',refillsToday:1,cap:3}]},text:'Goals need work',detail:'Fixture goal: 1 refilled today of 3'},
 {body:{kind:'pr-ready-for-review',threadId:'linked',prNumber:7,commit:sha('a')},text:'Pull request #7 is ready for the coordinator\'s review',detail:'Commit '+sha('a')},
 {body:{kind:'merge-gate',threadId:'linked',prNumber:7,commit:sha('a'),outcome:'ask-owner',summary:'Fixture gate summary.'},text:'Pull request #7: ask owner',detail:'Fixture gate summary.'},
 {body:{kind:'task-reviewed',taskId:'task_fixture',title:'Fixture task',outcome:'approved'},text:'You approved "Fixture task"'},
 {body:{kind:'task-not-started',taskId:'task_fixture',title:'Fixture task',reason:'Fixture start refusal.'},text:'"Fixture task" could not start',detail:'Fixture start refusal.'},
];
test.each(expanded)('project chat expanded event copy $body.kind',({body,text,detail})=>{
 const envelope=coordinator(body),parsed=core.CoordinatorEventSchema.parse(envelope.data) as CoordinatorEvent;expect(parsed.kind).toBe(body.kind);const p=policy();expect(p.items([envelope],()=> 'Fixture title')).toEqual([{kind:'event',id:1,text,...(detail?{detail}:{}),...('threadId'in body?{threadId:body.threadId}:{}),delivered:false}]);
});

test('project chat normal API and owner read share bounded canonical pages without worker starts',async()=>{
 const made=await projectChatFixture();f=made.f;const before=made.ledger.events(),starts=f.fake.runs.length,response=await f.request('/api/projects/project/coordinator/chat-view','POST',request());expect(response.status).toBe(200);const view=await response.json();expect(view).toMatchObject({schema:'project-chat-view-v1',projectId:'project',deviceId:f.app.device.deviceId,head:made.ledger.lastId(),items:expect.arrayContaining([expect.objectContaining({kind:'owner',heading:'You, via CLI',text:'A recorded fixture request.',delivered:true}),expect.objectContaining({kind:'reply',text:'Two recorded fixture tasks.'})])});expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'chat_view',args:{project:'project'}})).toMatchObject({ok:true,data:view});expect((await f.request('/api/projects/project/coordinator/chat-view','POST',request({events:[]}))).status).toBe(400);expect((await f.request('/api/projects/project/coordinator/chat-view','POST',request({deviceId:'other_device'}))).status).toBe(409);expect(made.ledger.events()).toEqual(before);expect(f.fake.runs.length).toBe(starts);
});

test('project chat direct purpose reader applies existing read-time redaction without rewriting history',async()=>{
 const made=await projectChatFixture();f=made.f;const before=made.ledger.events();f.app.redactor.add(made.marker);const read=Reflect.get(made.work,'chatView');expect(read).toBeTypeOf('function');const view=await read.call(made.work,'project',request());expect(JSON.stringify(view).includes(made.marker)).toBe(false);expect(made.ledger.events()).toEqual(before);expect(JSON.stringify(made.ledger.data(made.notice)).includes(made.marker)).toBe(true);
});

test('project chat owner purpose reader forwards to its current member coordinator ledger',async()=>{
 f=await projectFixture({coordinator:true});const member=await projectMember(f);await member.app.projectHub.assignCoordinator('project',member.deviceId,0);const work=member.app.projectWork,current=(await work.settingsView('project')).settings,{schema:_s,projectId:_p,revision,...settings}=current;void _s;void _p;await work.putSettings('project',{schema:'project-work-settings-request-v1',revision,settings:{...settings,status:'paused'}});const a=await work.tasks.save(task('member_one','Member one',{projectId:'project',revision:0,held:true,rank:'4'})),b=await work.tasks.save(task('member_two','Member two',{projectId:'project',revision:0,held:true,rank:'c'}));seedProjectChat(work,[a.id,b.id]);const hubHead=f.app.projectWork.coordinatorLedger('project').lastId(),response=await member.request('/api/projects/project/coordinator/chat-view','POST',request());expect(response.status).toBe(200);const view=await response.json();expect(view).toMatchObject({schema:'project-chat-view-v1',deviceId:member.deviceId,items:expect.arrayContaining([expect.objectContaining({kind:'owner',heading:'You, via CLI'})])});expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'chat_view',args:{project:'project'}})).toMatchObject({ok:true,data:view});expect(f.app.projectWork.coordinatorLedger('project').lastId()).toBe(hubHead);expect(f.fake.runs.length).toBe(0);expect(member.fake.runs.length).toBe(0);
});
