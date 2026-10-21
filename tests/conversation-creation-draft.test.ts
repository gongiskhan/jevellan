import {afterEach,expect,test,vi} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
const choices=()=>core.ComposerInitialSchema.parse({schema:'composer-initial-v1',once:{},pins:{}});
const input=(message='First line\nMore detail')=>({schema:'conversation-creation-intent-v1',projectId:'project',message,choices:choices()});
const prepare=(raw:Record<string,unknown>,mint:()=>string)=>{const fn=Reflect.get(core,'conversationCreationDraft');expect(fn).toBeTypeOf('function');return fn(raw,mint,(signature:string)=>signature);};

test('conversation creation draft retains ids for the exact raw project/message/choices signature and remints only after a change',()=>{
 const mint=vi.fn(()=>`opaque_${mint.mock.calls.length}`),raw=input(),first=prepare(raw,mint);expect(mint).toHaveBeenCalledTimes(2);expect(first.pending).toMatchObject({schema:'conversation-creation-pending-v1',signature:JSON.stringify({projectId:raw.projectId,message:raw.message,choices:raw.choices}),id:'conversation_opaque_1',clientMessageId:'message_opaque_2'});const same=prepare({...raw,previous:first.pending},mint);expect(same.pending).toEqual(first.pending);expect(mint).toHaveBeenCalledTimes(2);const changed=prepare({...raw,message:raw.message+' ',previous:first.pending},mint);expect(changed.pending.id).not.toBe(first.pending.id);expect(mint).toHaveBeenCalledTimes(4);const projectChanged=prepare({...raw,projectId:'another',previous:first.pending},mint);expect(projectChanged.pending.id).not.toBe(first.pending.id);expect(mint).toHaveBeenCalledTimes(6);const choiceChanged=prepare({...raw,choices:{...choices(),once:{effort:'high'}},previous:first.pending},mint);expect(choiceChanged.pending.id).not.toBe(first.pending.id);expect(mint).toHaveBeenCalledTimes(8);
});

test('conversation creation draft derives the first-line100 title and omits empty choices while preserving once/pins',()=>{
 let n=0;const mint=()=>`opaque_${++n}`;const empty=prepare(input('x'.repeat(130)+'\nMore'),mint);expect(empty.request).toMatchObject({schema:'start-conversation-v1',projectId:'project',title:'x'.repeat(100),message:'x'.repeat(130)+'\nMore'});expect(empty.request).not.toHaveProperty('choices');expect(empty.refusal).toBeNull();const picked={...choices(),pins:{effort:'high'}};const changed=prepare({...input(),choices:picked},mint);if(!changed.request)throw Error('A valid title must prepare a creation request.');expect(changed.request.choices).toEqual(picked);
});

test('conversation creation draft preserves its pending identity through invalid first-line title preparation',()=>{
 const mint=vi.fn(()=>`opaque_${mint.mock.calls.length}`),raw=input('\nA later line'),first=prepare(raw,mint);expect(first.request).toBeNull();expect(first.refusal).toBeTypeOf('string');expect(mint).toHaveBeenCalledTimes(2);expect(prepare({...raw,previous:first.pending},mint).pending).toEqual(first.pending);expect(mint).toHaveBeenCalledTimes(2);
});

test('conversation creation draft rejects unknown or unversioned intents and pending receipts',()=>{
 const schema=Reflect.get(core,'ConversationCreationIntentSchema');expect(schema).toBeDefined();expect(()=>schema.parse({...input(),extra:true})).toThrow();expect(()=>schema.parse({...input(),schema:'old'})).toThrow();expect(()=>schema.parse({...input(),previous:{schema:'old',id:'a'}})).toThrow();
});

test('conversation creation draft normal HTTP and tool prepare only, retaining ids without creating ledger or work',async()=>{
 f=await projectFixture();const raw=input(),response=await f.request('/api/conversation-new/draft','POST',raw);expect(response.status).toBe(200);const draft=await response.json();expect(draft).toMatchObject({schema:'conversation-creation-draft-v1',request:{schema:'start-conversation-v1',title:'First line'}});const result=await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'conversation_create_draft',args:{project:'project',request:{...raw,previous:draft.pending}}});expect(result).toMatchObject({ok:true,data:draft});expect((await f.app.conversations.list()).conversations).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});

test('conversation creation draft preserves authentication, strict inputs and POST-only reads',async()=>{
 f=await projectFixture();const path='/api/conversation-new/draft';expect((await fetch(f.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input())})).status).toBe(401);expect((await f.request(path)).status).toBe(405);expect((await f.request(path,'POST',{...input(),extra:true})).status).toBe(400);expect(f.fake.starts).toHaveLength(0);
});


test('conversation creation draft retains retry identity through normal response redaction without exposing source signatures',async()=>{
 f=await projectFixture();const sensitive=`fixture-draft-sensitive-${Date.now()}`;f.app.redactor.add(sensitive);const raw=input('A safe title\n'+sensitive),path='/api/conversation-new/draft';const firstResponse=await f.request(path,'POST',raw);expect(firstResponse.status).toBe(200);const first=await firstResponse.json();expect(first.pending.signature.includes(sensitive)).toBe(false);expect(first.request.message.includes(sensitive)).toBe(false);const againResponse=await f.request(path,'POST',{...raw,previous:first.pending});expect(againResponse.status).toBe(200);const again=await againResponse.json();expect(again.pending.id===first.pending.id).toBe(true);expect(again.pending.clientMessageId===first.pending.clientMessageId).toBe(true);expect(/^[a-f0-9]{64}$/.test(first.pending.signature)).toBe(true);const changed=sensitive+'-changed';f.app.redactor.add(changed);const next=await(await f.request(path,'POST',{...input('A safe title\n'+changed),previous:first.pending})).json();expect(next.pending.id===first.pending.id).toBe(false);expect((await f.app.conversations.list()).conversations).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});
