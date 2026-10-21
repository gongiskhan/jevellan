import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
async function base(){f=await projectFixture();await f.app.conversations.create({schema:'start-conversation-v1',id:'controls_fixture',projectId:'project',title:'Controls fixture',message:'Wait for the next fixture step.',clientMessageId:'controls_first'});await f.app.conversations.wait('controls_fixture');return f.app.conversations.view('controls_fixture');}
const controls=(raw:unknown)=>{const prepare=Reflect.get(core,'conversationControlsView');expect(prepare).toBeTypeOf('function');return prepare(core.ConversationPublicSchema.parse(raw));};
const finish=(status:'requested'|'blocked'|'completed',id=status)=>core.FinishOutsideOperationSchema.parse({schema:'finish-outside-operation-v1',request:{schema:'finish-outside-v1',clientRequestId:'finish_'+id,generation:0},workId:null,status,...(status==='completed'?{retained:true}:{}),reason:'Preserve the fixture.'});

test('conversation controls share running state, chip copy and active settlement presentation',async()=>{
 const view=await base(),id=view.conversation.work!.id;
 expect(controls(view)).toMatchObject({schema:'conversation-controls-view-v1',running:false,stateLabel:'Waiting for you',settlement:{target:{id},available:true,kept:false,shown:true,label:'Close this work'}});
 expect(controls({...view,busy:true})).toMatchObject({running:true,state:'running',stateLabel:'Working',settlement:{available:true,shown:false}});
 expect(controls({...view,conversation:{...view.conversation,state:'running'}})).toMatchObject({running:true,stateLabel:'Working'});
});

test('conversation controls preserve every closed-work settlement retention case and last matching receipt',async()=>{
 const view=await base(),work={...view.conversation.work!,closedAs:'closed-by-you' as const},closed={...view,conversation:{...view.conversation,work:null},closedWorks:[work],settlements:[]};
 expect(controls(closed)).toMatchObject({settlement:{target:{id:work.id},available:true,kept:true,shown:true,label:'Settle kept changes'},messageActions:{canEdit:false,canRetry:false}});
 const receipt=core.WorkSettlementSchema.parse({schema:'work-settlement-v1',id:'settled',workId:work.id,choice:'keep',status:'completed',closedAs:'closed-by-you',reclose:false,retained:false});
 expect(controls({...closed,settlements:[receipt]})).toMatchObject({settlement:{available:false,kept:false,shown:false}});
 expect(controls({...closed,settlements:[{...receipt,retained:true}]})).toMatchObject({settlement:{available:true,kept:true}});
 expect(controls({...closed,settlements:[{...receipt,status:'blocked'}]})).toMatchObject({settlement:{available:true,kept:true}});
 expect(controls({...closed,settlements:[{...receipt,retained:true},{...receipt,id:'other',workId:'unrelated'}]})).toMatchObject({settlement:{available:true}});
 expect(controls({...closed,closedWorks:[{...work,closedAs:'done'}]})).toMatchObject({settlement:{available:false,kept:false}});
 expect(controls({...closed,closedWorks:[]})).toMatchObject({settlement:{target:null,available:false,kept:false,shown:false}});
});

test('conversation controls preserve first unfinished finish and latest target checkpoint without relaxing message guards',async()=>{
 const view=await base(),workId=view.conversation.work!.id,first=finish('requested'),blocked=finish('blocked'),checkpoint={schema:'checkpoint-block-v1',workId,stretch:2,reason:'Check the fixture.',eventId:3};
 expect(controls({...view,finishes:[finish('completed'),first,blocked]})).toMatchObject({finishing:first,blockedFinish:null,canFinishOutside:false,settlement:{shown:false},messageActions:{canEdit:false,canRetry:false}});
 expect(controls({...view,finishes:[blocked,first]})).toMatchObject({finishing:blocked,blockedFinish:blocked});
 expect(controls({...view,conversation:{...view.conversation,outcome:{kind:'finished-elsewhere',at:'2026-10-01T00:00:00Z'}}})).toMatchObject({canFinishOutside:false});
 const source={...view,checkpointBlocks:[{...checkpoint,eventId:1,stretch:1},checkpoint,{...checkpoint,workId:'another',eventId:4,stretch:3}]};
 expect(controls(source)).toMatchObject({checkpointBlock:checkpoint,recovery:{checkpoint},messageActions:{canEdit:false,canRetry:false}});
 expect(controls({...source,busy:true})).toMatchObject({checkpointBlock:checkpoint,recovery:{checkpoint:null}});
 expect(controls(view)).toMatchObject({finishing:null,blockedFinish:null,canFinishOutside:true,messageActions:{canEdit:true,canRetry:true}});
});

test('conversation controls keep distinct recovery gates and first-occurrence account ordering',async()=>{
 const view=await base(),workId=view.conversation.work!.id,decisionWait=core.DecisionWaitSchema.parse({schema:'decision-wait-v1',workId,generation:0,kind:'choice-unavailable',text:'Choose fixture resources.',calls:[],reasons:[{modelId:'fixture',reason:'Fixture wait.',accountIds:['account_b','account_a','account_b']},{modelId:'another',reason:'Another wait.',accountIds:['account_c','account_a']}]}),externalWait=core.ExternalActivityWaitSchema.parse({schema:'external-activity-wait-v1',id:'wait',workId,generation:0,source:'manual',choice:{schema:'manual-step-v1',generation:0,action:'reply'}}),source={...view,decisionWait,externalWait};
 expect(controls(source)).toMatchObject({recovery:{externalRetry:true,decision:true,accountIds:['account_b','account_a','account_c']}});
 expect(controls({...source,pause:{schema:'work-control-v1',kind:'pause',state:'waiting-for-you',reason:'Fixture guard.',guard:'steps'}})).toMatchObject({recovery:{externalRetry:true,decision:false,accountIds:[]},messageActions:{canEdit:true,canRetry:false}});
 expect(controls({...source,finishes:[finish('requested')]})).toMatchObject({recovery:{externalRetry:false,decision:true}});
 expect(controls({...source,busy:true})).toMatchObject({recovery:{externalRetry:false,decision:false,accountIds:[]}});
});

test('conversation controls expose only blocked redos for the target or immediately preceding work',async()=>{
 const view=await base(),current=view.conversation.work!,previous={...current,id:'previous',closedAs:'closed-by-you' as const},older={...previous,id:'older'};
 const redo=(id:string,workId:string,followingWorkId?:string)=>core.RedoOperationSchema.parse({schema:'redo-operation-v1',id,workId,...(followingWorkId?{followingWorkId}:{}),status:'blocked',generation:0,fromStretch:1});
 const active=redo('active',current.id),prior=redo('prior',previous.id,current.id),other=redo('other','unrelated'),old=redo('old',older.id,current.id),complete={...active,id:'complete',status:'completed' as const},source={...view,closedWorks:[older,previous],redos:[active,prior,other,old,complete]};
 expect(controls(source)).toMatchObject({recovery:{redos:[active,prior]}});expect(controls({...source,busy:true})).toMatchObject({recovery:{redos:[]}});
 expect(controls({...source,conversation:{...view.conversation,work:null}})).toMatchObject({recovery:{redos:[prior]}});
});

test('conversation controls own offered-question presence and first-option primary presentation',async()=>{
 const view=await base(),openQuestion={stretch:1,text:'Which fixture?',options:[{label:'First',detail:'Keep it.'},{label:'Second'}]};
 expect(controls({...view,openQuestion})).toMatchObject({question:{stretch:1,text:openQuestion.text,options:[{index:0,label:'First',detail:'Keep it.',primary:true},{index:1,label:'Second',primary:false}]}});
 expect(controls({...view,openQuestion:{...openQuestion,options:[]}})).toMatchObject({question:null});expect(controls(view)).toMatchObject({question:null});
});

test('conversation controls canonical HTTP and owner tool expose identical strict metadata without extra work',async()=>{
 const view=await base(),id=view.conversation.id,ordinary=await(await f!.request(`/api/conversations/${id}`)).json(),before=f!.app.conversations.ledger(id).events().length;
 expect(ordinary).toMatchObject({controls:{schema:'conversation-controls-view-v1'}});expect(ordinary.controls).toEqual(controls(view));
 expect(await f!.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_view',args:{project:'project',conversation:id}})).toMatchObject({ok:true,data:{controls:ordinary.controls}});
 expect(core.ConversationPublicSchema.safeParse({...ordinary,controls:{...ordinary.controls,extra:true}}).success).toBe(false);
 const {controls:removed,...legacy}=ordinary;expect(removed).toBeDefined();expect(core.ConversationPublicSchema.safeParse(legacy).success).toBe(true);
 expect(f!.app.conversations.ledger(id).events()).toHaveLength(before);expect(f!.fake.starts).toHaveLength(0);
});

test('conversation controls member and headless hub reads preserve canonical owner-device state',async()=>{
 f=await projectFixture();const member=await projectMember(f),id='member_controls';await member.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'Member controls',message:'Wait for the fixture.',clientMessageId:'member_controls_first'});await member.app.conversations.wait(id);await member.app.conversations.list();const view=await(await member.request(`/api/conversations/${id}`)).json();expect(view).toMatchObject({controls:{schema:'conversation-controls-view-v1'},conversation:{ownerDeviceId:member.deviceId}});
 const before=member.app.conversations.ledger(id).events().length;expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_view',args:{project:'project',conversation:id}})).toMatchObject({ok:true,data:{controls:view.controls,conversation:{ownerDeviceId:member.deviceId}}});expect(member.app.conversations.ledger(id).events()).toHaveLength(before);expect(f.fake.starts).toHaveLength(0);expect(member.fake.starts).toHaveLength(0);
});
