import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
async function base(branchPolicy:'main'|'external'='main'){f=await projectFixture({branchPolicy});await f.app.conversations.create({schema:'start-conversation-v1',id:'settlement_editor',projectId:'project',title:'Settlement fixture',message:'Preserve the fixture.',clientMessageId:'settlement_first'});await f.app.conversations.wait('settlement_editor');return f.app.conversations.view('settlement_editor');}
function policy(){const context=Reflect.get(core,'conversationSettlementContext'),editor=Reflect.get(core,'conversationSettlementEditor'),draft=Reflect.get(core,'conversationSettlementDraft');for(const fn of[context,editor,draft])expect(fn).toBeTypeOf('function');let minted=0;return{context,editor,draft:(view:Parameters<typeof draft>[0],project:core.Project,raw:unknown)=>draft(view,project,raw,()=>`settlement_${++minted}`),minted:()=>minted};}
const editorRequest=(context?:unknown)=>({schema:'conversation-settlement-editor-request-v1',...(context?{context}:{})});
const draftRequest=(context:unknown,choice:'publish'|'keep'|'discard',pending?:unknown)=>({schema:'conversation-settlement-draft-request-v1',context,choice,...(pending?{pending}:{})});

test('conversation settlement editor owns main choices, descriptions and exact discard consequences',async()=>{
 const view=await base(),p=policy(),editor=p.editor(view,f!.project,editorRequest());expect(editor).toMatchObject({schema:'conversation-settlement-editor-v1',projectId:'project',conversationId:view.conversation.id,title:'Close this work',intro:'Choose what happens to this work’s unpublished changes.',context:{workId:view.conversation.work!.id,generation:view.conversation.generation}});
 expect(editor.choices).toEqual([{choice:'publish',label:'Publish',description:'Verify the final checkpoint, bring in newer work from main, and publish.',secondary:false,confirm:false},{choice:'keep',label:'Keep them',description:'Close the work and keep its changes. The checkout stays reserved while changes remain unsettled.',secondary:true,confirm:false},{choice:'discard',label:'Discard…',description:'Save a recovery ref, then reset unpublished checkpoints.',secondary:true,confirm:true}]);
 expect(editor.confirmation).toEqual({title:'Discard this work',paragraphs:['This resets this work’s unpublished code and memory checkpoints to where the work started. A recovery ref is saved first. Uncommitted files must be checkpointed before they can be discarded.','Anything outside the repository, such as databases, deployments or messages sent, is not undone.'],submitLabel:'Discard checkpoints',backLabel:'Back'});expect(f!.fake.starts).toHaveLength(0);
});

test('conversation settlement editor enforces canonical external keep-only preparation',async()=>{
 const view=await base('external'),p=policy(),editor=p.editor(view,f!.project,editorRequest());expect(editor).toMatchObject({intro:'This project follows its own git rules. Its files stay as they are.',confirmation:null,choices:[{choice:'keep',label:'Close and keep changes',description:null,secondary:false,confirm:false}]});
 for(const choice of['publish','discard']as const)expect(()=>p.draft(view,f!.project,draftRequest(editor.context,choice))).toThrow(/own git rules/u);expect(p.minted()).toBe(0);
});

test('conversation settlement draft pins reviewed target and generation and reuses only its matching choice receipt',async()=>{
 const view=await base(),p=policy(),context=p.context(view),first=p.draft(view,f!.project,draftRequest(context,'keep'));
 expect(first).toMatchObject({schema:'conversation-settlement-draft-v1',command:{schema:'conversation-settlement-command-v1',body:{schema:'settle-work-v1',workId:context.workId,generation:context.generation,choice:'keep'}}});
 const later={...view,conversation:{...view.conversation,generation:view.conversation.generation+1,work:{...view.conversation.work!,id:'later_work'}}};
 expect(p.draft(later,f!.project,draftRequest(context,'keep',first.pending)).command).toEqual(first.command);expect(p.minted()).toBe(1);
 expect(p.draft(later,f!.project,draftRequest(context,'discard',first.pending)).command.body.clientRequestId).not.toBe(first.command.body.clientRequestId);
 const fresh=p.context(later);expect(p.draft(later,f!.project,draftRequest(fresh,'keep',first.pending)).command.body.clientRequestId).not.toBe(first.command.body.clientRequestId);
});

test('conversation settlement editor rejects foreign scope, unknown fields and unavailable initial targets',async()=>{
 const view=await base(),p=policy(),context=p.context(view);expect(()=>p.editor(view,{...f!.project,id:'other'},editorRequest())).toThrow(/project/u);expect(()=>p.editor(view,f!.project,editorRequest({...context,conversationId:'other'}))).toThrow(/conversation/u);expect(()=>p.draft(view,f!.project,draftRequest({...context,projectId:'other'},'keep'))).toThrow(/project/u);expect(()=>p.editor(view,f!.project,{...editorRequest(),extra:true})).toThrow();expect(()=>p.context(view,'other_work')).toThrow(/work/u);expect(()=>p.context({...view,conversation:{...view.conversation,work:null},closedWorks:[]})).toThrow(/work/u);
});

test('conversation settlement normal HTTP and tool command preserve exact receipt and later work',async()=>{
 const view=await base(),id=view.conversation.id,read=await f!.request(`/api/conversations/${id}/settlement-editor`,'POST',editorRequest());expect(read.status).toBe(200);const editor=await read.json(),prepared=await f!.request(`/api/conversations/${id}/settlement-draft`,'POST',draftRequest(editor.context,'keep'));expect(prepared.status).toBe(200);const draft=await prepared.json();
 expect((await f!.request(`/api/conversations/${id}/settlement-command`,'POST',draft.command)).status).toBe(200);await f!.app.conversations.wait(id);expect((await f!.app.conversations.view(id)).settlements).toMatchObject([{choice:'keep',status:'completed'}]);
 await f!.app.conversations.message(id,{schema:'conversation-message-v1',clientMessageId:'later_settlement_work',text:'Preserve this newer work.'});await f!.app.conversations.wait(id);const later=await f!.app.conversations.view(id),count=f!.app.conversations.ledger(id).events().length;
 const replay=await f!.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_settle',args:{project:'project',conversation:id,request:draft.command}});expect(replay).toMatchObject({ok:true,data:{conversation:later.conversation}});expect(f!.app.conversations.ledger(id).events()).toHaveLength(count);expect(f!.fake.starts).toHaveLength(0);
});

test('conversation settlement stale generation and old target reach unchanged writer guards without closing new work',async()=>{
 const view=await base(),id=view.conversation.id,p=policy(),context=p.context(view);await f!.app.conversations.message(id,{schema:'conversation-message-v1',clientMessageId:'settlement_generation_change',text:'Another fixture instruction.'});await f!.app.conversations.wait(id);const draft=p.draft(await f!.app.conversations.view(id),f!.project,draftRequest(context,'keep'));expect((await f!.request(`/api/conversations/${id}/settlement-command`,'POST',draft.command)).status).toBe(409);expect((await f!.app.conversations.view(id)).conversation.work).not.toBeNull();expect((await f!.app.conversations.view(id)).settlements).toHaveLength(0);
});

test('conversation settlement external command cannot forge publish or discard and keep leaves git intact',async()=>{
 const view=await base('external'),id=view.conversation.id,refs=f!.git(f!.checkout,'show-ref'),status=f!.git(f!.checkout,'status','--porcelain'),context=policy().context(view);
 for(const choice of['publish','discard']as const){expect((await f!.request(`/api/conversations/${id}/settlement-draft`,'POST',draftRequest(context,choice))).status).toBe(409);expect((await f!.request(`/api/conversations/${id}/settlement-command`,'POST',{schema:'conversation-settlement-command-v1',body:{schema:'settle-work-v1',clientRequestId:`forged_${choice}`,workId:context.workId,generation:context.generation,choice}})).status).toBe(409);}
 const draft=await(await f!.request(`/api/conversations/${id}/settlement-draft`,'POST',draftRequest(context,'keep'))).json();expect((await f!.request(`/api/conversations/${id}/settlement-command`,'POST',draft.command)).status).toBe(200);await f!.app.conversations.wait(id);expect(f!.git(f!.checkout,'show-ref')).toBe(refs);expect(f!.git(f!.checkout,'status','--porcelain')).toBe(status);expect(f!.fake.starts).toHaveLength(0);
});

test('conversation settlement member routing, project binding and strict methods preserve actual owner',async()=>{
 f=await projectFixture();const member=await projectMember(f),id='member_settlement';await member.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'Member settlement',message:'Preserve the member fixture.',clientMessageId:'member_settlement_first'});await member.app.conversations.wait(id);await member.app.conversations.list();
 const read=await member.request(`/api/conversations/${id}/settlement-editor`,'POST',editorRequest());expect(read.status).toBe(200);const editor=await read.json(),draft=await(await member.request(`/api/conversations/${id}/settlement-draft`,'POST',draftRequest(editor.context,'keep'))).json();expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_settle',args:{project:'another',conversation:id,request:draft.command}})).toMatchObject({ok:false});expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_settle',args:{project:'project',conversation:id,request:draft.command}})).toMatchObject({ok:true,data:{conversation:{ownerDeviceId:member.deviceId}}});await member.app.conversations.wait(id);expect(f.app.conversations.hasLocalConversation(id)).toBe(false);expect((await member.request(`/api/conversations/${id}/settlement-editor`)).status).toBe(405);expect((await member.request(`/api/conversations/${id}/settlement-command`,'POST',{...draft.command,extra:true})).status).toBe(400);expect(member.fake.starts).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});
