import {afterEach,expect,test,vi} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import type {LedgerEvent} from '../packages/core/dist/index.js';
import {ownerConversationOperation} from '../apps/daemon/dist/owner-proxy.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
import {conversationReadingFixture} from './helpers/conversation-reading-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;});
const event=(id:number,text='Fixture event.'):LedgerEvent=>({schema:'ledger-event-v1',id,t:'2026-10-21T12:00:00.000Z',type:'text',stretch:1,data:{delta:text}});
const request=(afterId=0,limit=64)=>({schema:'conversation-stream-request-v1',afterId,limit});
function policy(){const frame=Reflect.get(core,'conversationStreamFrame'),merge=Reflect.get(core,'conversationStreamEvents'),status=Reflect.get(core,'conversationStreamStatusView'),source=Reflect.get(core,'conversationStreamSource'),rules=Reflect.get(core,'conversationStreamPolicy');for(const fn of[frame,merge,status,source,rules])expect(fn).toBeTypeOf('function');return{frame,merge,status,source,rules};}

test('conversation stream policy preserves first id wins and duplicate array identity with ascending new events',()=>{
 const p=policy(),first=event(3,'First recorded value.'),prior=[first,event(1)],duplicate=p.merge(prior,event(3,'A duplicate must not replace history.'));expect(duplicate).toBe(prior);expect(duplicate).toEqual(prior);
 const merged=p.merge(prior,event(2));expect(merged.map(row=>row.id)).toEqual([1,2,3]);expect(merged[2]).toBe(first);expect(prior.map(row=>row.id)).toEqual([3,1]);
});

test('conversation stream policy validates frames and retains the shared forty millisecond window',()=>{
 const p=policy(),raw={schema:'conversation-event-v1',event:event(1)};expect(p.frame(raw)).toEqual({schema:'conversation-stream-frame-v1',event:raw.event,refreshWindowMs:40});expect(p.rules()).toMatchObject({schema:'conversation-stream-policy-v1',refreshWindowMs:40,duplicate:'first-id-wins',order:'ascending',malformed:'close',statusRequiresInitialView:true});
 expect(p.frame(JSON.stringify(raw))).toEqual(p.frame(raw));expect(()=>p.frame('not JSON')).toThrow();
 expect(()=>p.frame({...raw,extra:true})).toThrow();expect(()=>p.frame({...raw,event:{...raw.event,id:0}})).toThrow();expect(()=>p.frame({schema:'other',event:event(1)})).toThrow();
});

test('conversation stream policy ignores stopped early and foreign status snapshots while rejecting malformed admitted frames',async()=>{
 const made=await conversationReadingFixture();f=made.f;const view=await made.finish(),p=policy(),context={conversationId:made.id,initialReady:true,stopped:false},frame={schema:'conversation-status-event-v1',view};
 expect(p.status({}, {...context,stopped:true})).toBeNull();expect(p.status({}, {...context,initialReady:false})).toBeNull();expect(p.status(frame,context)).toEqual(view);expect(p.status({...frame,view:{...view,conversation:{...view.conversation,id:'other'}}},context)).toBeNull();expect(()=>p.status({...frame,extra:true},context)).toThrow();
 expect(p.status('not JSON',{...context,initialReady:false})).toBeNull();expect(p.status(JSON.stringify(frame),context)).toEqual(view);expect(()=>p.status('not JSON',context)).toThrow();
});

test('conversation stream policy source uses strict bounded cursors and the same policy without posting prior history',()=>{
 const p=policy(),facts={projectId:'project',conversationId:'fixture',head:5,events:[event(3),event(4)]},input=request(2,2),value=p.source(facts,input);expect(value).toMatchObject({schema:'conversation-stream-source-v1',projectId:'project',conversationId:'fixture',request:input,head:5,nextAfterId:4,hasMore:true,events:facts.events,policy:p.rules()});expect(p.source({...facts,events:[],head:2},request(2))).toMatchObject({nextAfterId:2,hasMore:false,events:[]});
 for(const invalid of[{...input,limit:65},{...input,afterId:-1},{...input,extra:true},{...input,events:[] }])expect(()=>p.source(facts,invalid)).toThrow();expect(()=>p.source(facts,request(6))).toThrow(/ahead/iu);
});

test('conversation stream policy normal HTTP and tools page exact canonical public events without writes',async()=>{
 const made=await conversationReadingFixture();f=made.f;await made.finish();const ledger=f.app.conversations.ledger(made.id),ids=ledger.events().map(row=>row.id),count=ids.length,seen:number[]=[];let afterId=0;
 do{const input=request(afterId,2),response=await f.request(`/api/conversations/${made.id}/stream-source`,'POST',input);expect(response.status).toBe(200);const value=await response.json();expect(value).toMatchObject({schema:'conversation-stream-source-v1',projectId:'project',conversationId:made.id,request:input,head:ids.at(-1),policy:{refreshWindowMs:40}});expect(value.events.length).toBeLessThanOrEqual(2);expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_stream',args:{project:'project',conversation:made.id,request:input}})).toMatchObject({ok:true,data:value});seen.push(...value.events.map((row:LedgerEvent)=>row.id));afterId=value.nextAfterId;if(!value.hasMore)break;}while(afterId<ids.at(-1)!);
 expect(seen).toEqual(ids);expect(ledger.events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);expect((await f.request(`/api/conversations/${made.id}/stream-source`)).status).toBe(405);expect((await f.request(`/api/conversations/${made.id}/stream-source`,'POST',request(ids.at(-1)!+1))).status).toBe(400);expect((await f.request(`/api/conversations/${made.id}/stream-source`,'POST',{...request(),extra:true})).status).toBe(400);
});

test('conversation stream policy applies new redaction knowledge to old public event payloads on read',async()=>{
 const made=await conversationReadingFixture();f=made.f;await made.finish();const ledger=f.app.conversations.ledger(made.id),value='Synthetic archived fixture phrase.',record=ledger.append({type:'text',stretch:1,data:{delta:value}}),count=ledger.events().length;
 f.app.redactor.add(value);expect(JSON.stringify(ledger.redact({text:value})).includes(value)).toBe(false);
 const read=await f.app.conversations.streamSource(made.id,request(record.id-1,1));expect(JSON.stringify(read.events).includes(value)).toBe(false);expect(JSON.stringify(read.events)).toContain('[redacted]');expect(JSON.stringify(ledger.data(record)).includes(value)).toBe(true);expect(ledger.events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});

test('conversation stream policy member source binds owning scope and normalized cursor without moving history',async()=>{
 f=await projectFixture();const member=await projectMember(f),id='member_stream';await member.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'Member stream',message:'Preserve stream history.',clientMessageId:'member_stream_first'});await member.app.conversations.wait(id);await member.app.conversations.list();
 const input=request(0,2),ledger=member.app.conversations.ledger(id),count=ledger.events().length,response=await member.request(`/api/conversations/${id}/stream-source`,'POST',input);expect(response.status).toBe(200);const value=await response.json();expect(await ownerConversationOperation(f.app,'project',id,'stream-source',input)).toEqual(value);await expect(ownerConversationOperation(f.app,'other',id,'stream-source',input)).rejects.toMatchObject({status:409});expect(f.app.conversations.hasLocalConversation(id)).toBe(false);
 const route=Reflect.get(member.app.conversations,'streamSource');expect(route).toBeTypeOf('function');vi.spyOn(member.app.conversations,'streamSource').mockResolvedValueOnce({...value,request:{...value.request,afterId:1}});await expect(ownerConversationOperation(member.app,'project',id,'stream-source',input)).rejects.toMatchObject({status:502});expect(ledger.events()).toHaveLength(count);expect(member.fake.starts).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});
