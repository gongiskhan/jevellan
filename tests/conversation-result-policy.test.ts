import {afterEach,expect,test,vi} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {ownerConversationOperation} from '../apps/daemon/dist/owner-proxy.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
import {conversationReadingFixture} from './helpers/conversation-reading-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;});
const resultRequest=(pointer:string,displayKind:'plan'|'answer'='answer',fallback='Recorded fallback.')=>({schema:'conversation-reading-request-v1',kind:'result',pointer,displayKind,fallback});

test('conversation result policy preserves effort and exact token cost boundaries',()=>{
 const details=Reflect.get(core,'conversationStepDetails');expect(details).toBeTypeOf('function');
 const facts={effortRequested:'low',effortEffective:'high',usage:{inputTokens:0,outputTokens:0,costSource:'unknown'}} as const;
 expect(details(facts)).toEqual({schema:'conversation-step-details-v1',effortLabel:'low → high',tokens:0,usageLabel:null});
 for(const[tokens,label]of[[999,'999'],[1000,'1.0k'],[9999,'10.0k'],[10000,'10k'],[999999,'1000k'],[1000000,'1.0M']]as const){expect(details({...facts,effortRequested:'high',usage:{...facts.usage,inputTokens:tokens-1,outputTokens:1,cacheReadTokens:900000}})).toMatchObject({effortLabel:'high',tokens,usageLabel:label+' tokens'});}
 expect(details({...facts,usage:{...facts.usage,costUsd:0}}).usageLabel).toBe('$0.000');
 expect(details({...facts,usage:{inputTokens:1000,outputTokens:250,costUsd:0.12349,costSource:'estimated'}}).usageLabel).toBe('1.3k tokens · $0.123 est.');
 expect(details({...facts,usage:{inputTokens:1,outputTokens:2,costUsd:0.1235,costSource:'reported'}}).usageLabel).toBe('3 tokens · $0.123');
});

test('conversation result policy sums valid maximum directional counts without a new aggregate cap',()=>{
 const usage=core.UsageSchema.parse({inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:Number.MAX_SAFE_INTEGER,costSource:'unknown'});
 expect(core.conversationStepDetails({effortRequested:'high',effortEffective:'high',usage})).toMatchObject({tokens:18014398509481982,usageLabel:'18014398509.5M tokens'});
 expect(()=>core.ConversationStepDetailsSchema.parse({schema:'conversation-step-details-v1',effortLabel:'high',tokens:0.5,usageLabel:null})).toThrow();
});

test('conversation result policy preserves content serialization and exact fallback loading order',()=>{
 const present=Reflect.get(core,'conversationResultPresentation');expect(present).toBeTypeOf('function');
 const input={schema:'conversation-result-input-v1',kind:'answer',fallback:'Recorded fallback.'};
 for(const[content,text]of[['# Full answer','# Full answer'],[{value:1},'{\n  "value": 1\n}'],[null,'null'],[false,'false'],[0,'0'],[' ',' ']]as const)expect(present({...input,content})).toMatchObject({schema:'conversation-result-presentation-v1',kind:'answer',text,source:'content',className:'answer-result'});
 expect(present(input)).toMatchObject({text:'Recorded fallback.',source:'fallback'});expect(present({...input,content:''})).toMatchObject({text:'Recorded fallback.',source:'fallback'});
 expect(present({schema:'conversation-result-input-v1',kind:'plan',fallback:'',content:''})).toMatchObject({text:'Loading the full plan…',source:'loading',className:'plan-result'});
 expect(present({schema:'conversation-result-input-v1',kind:'answer'})).toMatchObject({text:'Loading the full answer…',source:'loading'});
 expect(()=>present({...input,extra:true})).toThrow();
});

test('conversation result policy normal HTTP and tools share recorded result and detail labels without writes',async()=>{
 const made=await conversationReadingFixture();f=made.f;const view=await made.finish(),pointer=view.handoffs[0]!.result!.ref,input=resultRequest(pointer,'answer',view.handoffs[0]!.summary),ledger=f.app.conversations.ledger(made.id),count=ledger.events().length;
 const response=await f.request(`/api/conversations/${made.id}/reading-view`,'POST',input);expect(response.status).toBe(200);const value=await response.json(),raw=await(await f.request(`/api/conversations/${made.id}/read?pointer=${encodeURIComponent(pointer)}`)).json();
 expect(value).toMatchObject({schema:'conversation-reading-view-v1',kind:'result',projectId:'project',conversationId:made.id,pointer,presentation:{schema:'conversation-result-presentation-v1',kind:'answer',text:raw.content,source:'content',className:'answer-result'}});
 expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_read_view',args:{project:'project',conversation:made.id,request:input}})).toMatchObject({ok:true,data:value});
 const step=await(await f.request(`/api/conversations/${made.id}/reading-view`,'POST',{schema:'conversation-reading-request-v1',kind:'step',step:1})).json();expect(step.details).toEqual(Reflect.get(core,'conversationStepDetails')(view.stretches[0]!));
 const legacy={...step};delete legacy.details;expect(core.ConversationReadingViewSchema.parse(legacy)).not.toHaveProperty('details');
 expect(ledger.events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);expect((await f.request(`/api/conversations/${made.id}/reading-view`,'POST',{...input,extra:true})).status).toBe(400);
});

test('conversation result policy canonical ledger reads preserve JSON empty and plan display without writes',async()=>{
 const made=await conversationReadingFixture();f=made.f;await made.finish();const ledger=f.app.conversations.ledger(made.id);
 const pointers=[{ref:ledger.putBlob({value:1}).ref,text:'{\n  "value": 1\n}',source:'content'},{ref:ledger.putBlob('').ref,text:'Recorded fallback.',source:'fallback'},{ref:ledger.putBlob(null).ref,text:'null',source:'content'}],count=ledger.events().length;
 for(const item of pointers){const response=await f.request(`/api/conversations/${made.id}/reading-view`,'POST',resultRequest(item.ref,'plan'));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:'result',pointer:item.ref,presentation:{kind:'plan',text:item.text,source:item.source,className:'plan-result'}});}
 expect(ledger.events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});

test('conversation result policy member reads bind exact pointer and display kind to the owning resource',async()=>{
 f=await projectFixture();const member=await projectMember(f),id='member_result';await member.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'Member result',message:'Preserve the fixture result.',clientMessageId:'member_result_first'});await member.app.conversations.wait(id);await member.app.conversations.list();
 const ledger=member.app.conversations.ledger(id),pointer=ledger.putBlob('# Member result').ref,input=resultRequest(pointer),count=ledger.events().length,response=await member.request(`/api/conversations/${id}/reading-view`,'POST',input);expect(response.status).toBe(200);const value=await response.json();expect(await ownerConversationOperation(f.app,'project',id,'reading-view',input)).toEqual(value);
 await expect(ownerConversationOperation(f.app,'other',id,'reading-view',input)).rejects.toMatchObject({status:409});expect(f.app.conversations.hasLocalConversation(id)).toBe(false);
 vi.spyOn(member.app.conversations,'readingView').mockResolvedValueOnce({...value,pointer:'ledger/1'});await expect(ownerConversationOperation(member.app,'project',id,'reading-view',input)).rejects.toMatchObject({status:502});
 vi.spyOn(member.app.conversations,'readingView').mockResolvedValueOnce({...value,presentation:{...value.presentation,kind:'plan',className:'plan-result'}});await expect(ownerConversationOperation(member.app,'project',id,'reading-view',input)).rejects.toMatchObject({status:502});
 expect(ledger.events()).toHaveLength(count);expect(member.fake.starts).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});
