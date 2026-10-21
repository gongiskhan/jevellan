import {afterEach,expect,test} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
async function base(){f=await projectFixture();await f.app.conversations.create({schema:'start-conversation-v1',id:'message_draft',projectId:'project',title:'Message draft',message:'Wait for the fixture.',clientMessageId:'draft_first'});await f.app.conversations.wait('message_draft');return f.app.conversations.view('message_draft');}
const request=(intent:unknown,pending?:unknown)=>({schema:'conversation-message-draft-request-v1',intent,...(pending?{pending}:{})});
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
function policy(){const prepare=Reflect.get(core,'conversationMessageDraft'),editor=Reflect.get(core,'conversationMessageEditor');expect(prepare).toBeTypeOf('function');expect(editor).toBeTypeOf('function');let minted=0;return{prepare:(view:unknown,raw:unknown)=>prepare(core.ConversationPublicSchema.parse(view),raw,(prefix:string)=>`${prefix}_${++minted}`,fingerprint),editor,minted:()=>minted};}
const messageBody=(draft:ReturnType<typeof core.conversationMessageDraft>)=>{if(draft.command?.operation!=='message')throw new Error('The fixture requires a prepared message command.');return draft.command.body;};

test('conversation message draft retains compose identity across text/kind changes until the caller clears its receipt',async()=>{
 const view=await base(),p=policy(),first=p.prepare(view,request({mode:'compose',kind:'message',text:'First message.'}));expect(first).toMatchObject({schema:'conversation-message-draft-v1',projectId:'project',conversationId:view.conversation.id,pending:{mode:'compose'},command:{schema:'conversation-message-command-v1',operation:'message',body:{schema:'conversation-message-v1',text:'First message.',kind:'message'}}});
 const changed=p.prepare(view,request({mode:'compose',kind:'note',text:'Changed note.'},first.pending));expect(messageBody(changed).clientMessageId).toBe(messageBody(first).clientMessageId);expect(messageBody(changed)).toMatchObject({text:'Changed note.',kind:'note'});expect(p.minted()).toBe(1);
 expect(messageBody(p.prepare(view,request({mode:'compose',kind:'message',text:'Next request.'}))).clientMessageId).not.toBe(messageBody(first).clientMessageId);
});

test('conversation message draft resends retain only exact event/text identity and ignore blank text without minting',async()=>{
 const view=await base(),p=policy(),eventId=view.messages[0]!.id,first=p.prepare(view,request({mode:'resend',eventId,text:'Edited fixture.'}));
 const same=p.prepare(view,request({mode:'resend',eventId,text:'Edited fixture.'},first.pending));expect(messageBody(same).clientMessageId).toBe(messageBody(first).clientMessageId);expect(messageBody(same).kind).toBe('message');expect(p.minted()).toBe(1);
 expect(messageBody(p.prepare(view,request({mode:'resend',eventId,text:'Edited fixture. '},same.pending))).clientMessageId).not.toBe(messageBody(first).clientMessageId);
 const count=p.minted(),blank=p.prepare(view,request({mode:'compose',kind:'message',text:' \n '},first.pending));expect(blank.command).toBeNull();expect(p.minted()).toBe(count);expect(blank.editor.canSend).toBe(false);
 expect(()=>p.prepare(view,request({mode:'resend',eventId:99999,text:'Missing record.'}))).toThrow(/message/u);
});

test('conversation message draft answers use the recorded label/stretch/option and do nothing without an offered option',async()=>{
 const view=await base(),p=policy(),openQuestion={stretch:1,text:'Choose the fixture.',options:[{label:'Keep it'},{label:'Change it',detail:'Use the alternative.'}]},source={...view,openQuestion};
 const answer=p.prepare(source,request({mode:'answer',option:1}));expect(answer).toMatchObject({pending:null,command:{operation:'message',body:{schema:'conversation-message-v1',kind:'message',text:'Change it',answer:{stretch:1,option:1}}}});expect(messageBody(answer).clientMessageId).toMatch(/^answer_/u);
 expect(p.prepare(view,request({mode:'answer',option:0})).command).toBeNull();expect(p.prepare(source,request({mode:'answer',option:3})).command).toBeNull();
});

test('conversation message draft latest-message retry prefers recorded decision wait then external wait then resend',async()=>{
 const view=await base();delete view.decisionWait;delete view.externalWait;const p=policy(),eventId=view.messages[0]!.id,workId=view.conversation.work!.id,generation=view.conversation.generation;
 const decisionWait=core.DecisionWaitSchema.parse({schema:'decision-wait-v1',workId,generation,kind:'jev-unavailable',text:'Fixture wait.',calls:[],reasons:[]}),externalWait=core.ExternalActivityWaitSchema.parse({schema:'external-activity-wait-v1',id:'external',workId,generation,source:'manual',choice:{schema:'manual-step-v1',generation,action:'reply'}}),intent={mode:'retry',eventId,text:'Retry the fixture.'};
 expect(p.prepare({...view,decisionWait,externalWait},request(intent))).toMatchObject({command:{operation:'resume',body:{schema:'resume-decision-v1',generation}}});expect(p.minted()).toBe(0);
 expect(p.prepare({...view,externalWait},request(intent))).toMatchObject({command:{operation:'retry-external',body:{schema:'retry-external-activity-v1',waitId:'external',generation}}});expect(p.minted()).toBe(0);
 const later={...view.messages[0]!,id:eventId+100,clientMessageId:'later'};expect(p.prepare({...view,messages:[...view.messages,later],decisionWait,externalWait},request(intent))).toMatchObject({command:{operation:'message',body:{text:intent.text,kind:'message'}}});
 expect(p.prepare(view,request(intent))).toMatchObject({command:{operation:'message',body:{text:intent.text}}});
});

test('conversation message draft editor preserves steering, kept/finish blocks, edit guards and blank policy',async()=>{
 const view=await base(),p=policy();expect(p.editor(view,'A message.')).toMatchObject({schema:'conversation-message-editor-v1',canSend:true,canSendEdited:true});expect(p.editor(view,' \n ')).toMatchObject({canSend:false,canSendEdited:false});
 expect(p.editor({...view,busy:true},'Steer this work.')).toMatchObject({canSend:true,canSendEdited:false});
 const work={...view.conversation.work!,closedAs:'closed-by-you' as const};expect(p.editor({...view,conversation:{...view.conversation,work:null},closedWorks:[work]},'New request.')).toMatchObject({canSend:false,canSendEdited:false});
 const finish=core.FinishOutsideOperationSchema.parse({schema:'finish-outside-operation-v1',request:{schema:'finish-outside-v1',clientRequestId:'finish',generation:0},workId:work.id,status:'blocked'});expect(p.editor({...view,finishes:[finish]},'New request.')).toMatchObject({canSend:false,canSendEdited:false});
});

test('conversation message draft normal HTTP and tool command share canonical message writes and idempotent receipts',async()=>{
 const view=await base(),id=view.conversation.id,response=await f!.request(`/api/conversations/${id}/message-draft`,'POST',request({mode:'compose',kind:'message',text:'Keep this fixture message.'}));expect(response.status).toBe(200);const draft=await response.json();expect(draft).toMatchObject({schema:'conversation-message-draft-v1',projectId:'project',conversationId:id});
 const written=await f!.request(`/api/conversations/${id}/message-command`,'POST',draft.command);expect(written.status).toBe(200);await f!.app.conversations.wait(id);const result=core.ConversationPublicSchema.parse(await written.json());expect(result.messages.at(-1)).toMatchObject({type:'user-message',text:'Keep this fixture message.',clientMessageId:draft.command.body.clientMessageId});const before=f!.app.conversations.ledger(id).events().length;
 expect(await f!.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_message',args:{project:'project',conversation:id,request:draft.command}})).toMatchObject({ok:true,data:{messages:result.messages}});expect(f!.app.conversations.ledger(id).events()).toHaveLength(before);expect(f!.fake.starts).toHaveLength(0);
});

test('conversation message draft redaction preserves retry identity and the existing canonical stored text',async()=>{
 const view=await base(),id=view.conversation.id,secret='private-fixture-'+randomUUID(),text='Keep this value private: '+secret;f!.app.redactor.add(secret);
 await f!.app.conversations.message(id,{schema:'conversation-message-v1',clientMessageId:'direct_private',text,kind:'message'});const expected=(await f!.app.conversations.view(id)).messages.at(-1)!.text,eventId=view.messages[0]!.id;
 const raw=request({mode:'resend',eventId,text}),response=await f!.request(`/api/conversations/${id}/message-draft`,'POST',raw);expect(response.status).toBe(200);const draft=await response.json(),repeat=await(await f!.request(`/api/conversations/${id}/message-draft`,'POST',request({mode:'resend',eventId,text},draft.pending))).json();expect(repeat.command.body.clientMessageId===draft.command.body.clientMessageId).toBe(true);expect(JSON.stringify(draft).includes(secret)).toBe(false);
 expect((await f!.request(`/api/conversations/${id}/message-command`,'POST',draft.command)).status).toBe(200);await f!.app.conversations.wait(id);expect((await f!.app.conversations.view(id)).messages.at(-1)!.text===expected).toBe(true);
});

test('conversation message command member writes stay with the indexed owner and preserve project/version/method guards',async()=>{
 f=await projectFixture();const member=await projectMember(f),id='member_message';await member.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'Member message',message:'Wait for the fixture.',clientMessageId:'member_first'});await member.app.conversations.wait(id);await member.app.conversations.list();
 const response=await member.request(`/api/conversations/${id}/message-draft`,'POST',request({mode:'compose',kind:'message',text:'Member fixture message.'}));expect(response.status).toBe(200);const draft=await response.json();expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_message',args:{project:'project',conversation:id,request:draft.command}})).toMatchObject({ok:true,data:{conversation:{ownerDeviceId:member.deviceId}}});
 expect((await member.app.conversations.view(id)).messages.at(-1)).toMatchObject({text:'Member fixture message.'});expect(f.app.conversations.hasLocalConversation(id)).toBe(false);expect((await member.request(`/api/conversations/${id}/message-draft`)).status).toBe(405);expect((await member.request(`/api/conversations/${id}/message-command`,'POST',{...draft.command,extra:true})).status).toBe(400);
 expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_message',args:{project:'another',conversation:id,request:draft.command}})).toMatchObject({ok:false});expect(member.fake.starts).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});

test('conversation message command preserves idle-note refusal and running-note delivery without another turn',async()=>{
 const view=await base(),id=view.conversation.id,command={schema:'conversation-message-command-v1',operation:'message',body:{schema:'conversation-message-v1',clientMessageId:'running_note',text:'Queue this harmless fixture note.',kind:'note'}};
 expect((await f!.request(`/api/conversations/${id}/messages`,'POST',command.body)).status).toBe(400);
 expect((await f!.request(`/api/conversations/${id}/message-command`,'POST',command)).status).toBe(400);
 f!.fake.capabilities.readOnlyEnforced=true;let release!:()=>void,entered!:()=>void;const done=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});f!.fake.enqueue(async({input,signal})=>{entered();await Promise.race([done,new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});})]);if(signal.aborted)return{status:'interrupted'};const response=await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`},body:JSON.stringify({schema:'bridge-request-v1',operation:'call',name:'jevellan_handoff',arguments:{schema:'handoff-v2',stretch:input.stretch,action:input.action,status:'done',summary:'The fixture note was delivered.',evidence:[],findings:[],blockers:[],failedApproaches:[],proposedNext:null,changedFiles:[]}})});expect(response.status).toBe(200);return{status:'completed'};});
 try{await f!.app.conversations.manual(id,{schema:'manual-step-v1',generation:view.conversation.generation,action:'reply',modelId:'fixture',effort:'medium'});await Promise.race([started,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('The owned fixture turn did not start.')),15000);timer.unref();})]);const response=await f!.request(`/api/conversations/${id}/message-command`,'POST',command);expect(response.status).toBe(200);expect((await response.json()).messages.at(-1)).toMatchObject({type:'note',text:command.body.text});expect(f!.fake.starts).toHaveLength(1);}finally{release();await f!.app.conversations.wait(id);}
});
