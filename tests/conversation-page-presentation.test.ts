import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {conversationPlanReviewFixture} from './helpers/conversation-plan-review-fixture.js';
import type {ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});

test('conversation labels retain every state, canonical action and progress stage in shared engine policy',()=>{
 const state=Reflect.get(core,'conversationStateLabel'),action=Reflect.get(core,'conversationActionLabel'),progress=Reflect.get(core,'conversationProgressPresentation');expect(state).toBeTypeOf('function');expect(action).toBeTypeOf('function');expect(progress).toBeTypeOf('function');
 for(const [id,label] of Object.entries({'waiting-for-you':'Waiting for you',running:'Running',done:'Done',cancelled:'Cancelled',blocked:'Blocked',idle:'Ready',future:'future'}))expect(state(id)).toBe(label);
 expect(action('ask-you')).toBe('Ask you');expect(action('verify-work')).toBe('Verify Work');
 const stages={preparing:['Preparing your request','Checking the project and available accounts.'],deciding:['Jev is choosing the next step','Classifying the request and selecting a model and effort.'],memory:['Preparing context','Selecting relevant project memory for this step.'],starting:['Starting the agent','The step is selected. Waiting for its first response.'],running:['Agent is working','Responses and tool activity appear below as they arrive.'],saving:['Saving this step','Checking changes and recording the handoff.'],verifying:['Checking the result','Validating the work before marking it complete.'],publishing:['Verifying and publishing','Running the final checks and saving the result.']};
 for(const [phase,[title,description]]of Object.entries(stages))expect(progress(Reflect.get(core,'ConversationProgressPhaseSchema').parse(phase))).toEqual({title,description});
});

test('manual-pick presentation preserves literal copy, suffix headings, guards and duplicate notices without routing free text',async()=>{
 const made=await conversationPlanReviewFixture();f=made.f;const prepare=Reflect.get(core,'conversationPagePresentation');expect(prepare).toBeTypeOf('function');
 const manual='Pick the next step, model and effort.',suffix='Jev is unavailable. Pick the next step:';
 const base=core.ConversationPublicSchema.parse({...made.view,busy:false,finishes:[],checkpointBlocks:[],pause:{schema:'work-control-v1',kind:'pause',state:'waiting-for-you',reason:manual}});
 const value=prepare(base);expect(value).toMatchObject({schema:'conversation-page-presentation-v1',picker:{shown:true,heading:null},pause:{kind:'manual-pick',notice:manual}});
 const withSuffix=core.ConversationPublicSchema.parse({...base,pause:{...base.pause,reason:suffix}});expect(prepare(withSuffix)).toMatchObject({picker:{shown:true,heading:suffix},pause:{kind:'manual-pick',notice:null}});
 expect(prepare({...withSuffix,busy:true})).toMatchObject({picker:{shown:false},pause:{notice:null}});
 expect(prepare(core.ConversationPublicSchema.parse({...base,pause:{...base.pause,guard:'steps'}}))).toMatchObject({picker:{shown:false}});
 expect(prepare(base,manual)).toMatchObject({pause:{notice:null}});
 const openQuestion={stretch:1,text:manual,options:[]};expect(prepare({...base,openQuestion})).toMatchObject({pause:{notice:null}});
 expect(prepare({...base,conversation:{...base.conversation,work:null}})).toMatchObject({picker:{shown:false}});
 expect(prepare(core.ConversationPublicSchema.parse({...base,pause:{...base.pause,reason:'A normal recorded pause.'}}))).toMatchObject({picker:{shown:false},pause:{kind:'other',notice:'A normal recorded pause.'}});
});

test('canonical conversation HTTP and explicit owner reader prepare identical page metadata without extra work',async()=>{
 const made=await conversationPlanReviewFixture();f=made.f;const starts=f.fake.starts.length,count=f.app.conversations.ledger(made.id).events().length;
 const ordinary=await(await f.request(`/api/conversations/${made.id}`)).json();expect(ordinary).toMatchObject({presentation:{schema:'conversation-page-presentation-v1'}});
 const result=await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_view',args:{project:'project',conversation:made.id}});expect(result).toMatchObject({ok:true,data:{presentation:ordinary.presentation}});expect(f.fake.starts).toHaveLength(starts);expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);
});

test('page presentation uses the newest valid public notice and retains a newer canonical snapshot', async()=>{
 const made=await conversationPlanReviewFixture();f=made.f;const latest=Reflect.get(core,'latestConversationNotice'),select=Reflect.get(core,'conversationPagePresentationForStream'),prepare=Reflect.get(core,'conversationPagePresentation');expect(latest).toBeTypeOf('function');expect(select).toBeTypeOf('function');
 const text='Pick the next step, model and effort.',base=core.ConversationPublicSchema.parse({...made.view,busy:false,finishes:[],checkpointBlocks:[],pause:{schema:'work-control-v1',kind:'pause',state:'waiting-for-you',reason:text}}),prepared=prepare(base,'An earlier notice.',2),view={...base,presentation:prepared};
 const event=(id:number,value:string)=>({id,data:{schema:'conversation-notice-v1',kind:'info',text:value}});
 const events=[event(1,'Earlier.'),event(3,text),{...event(4,'Invalid extra field.'),data:{...event(4,'').data,extra:true}}];
 expect(latest(events)).toEqual({id:3,text});expect(select(view,events)).toMatchObject({lastNoticeId:3,picker:{shown:true},pause:{notice:null}});expect(select(view,[event(1,'Earlier.')])).toBe(prepared);
});
