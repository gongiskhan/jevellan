import {afterEach,expect,test} from 'vitest';
import {JevLessonUseSchema,ProjectSchema,JevLessonSchema,ThreadCreatedViewSchema,ProjectWorkSettingsSchema,defaultProjectWorkSettings,LandingCorrectionSchema} from '../packages/core/dist/index.js';
import {forThread} from '../packages/runtime-contract/dist/index.js';
import {reportStep,commitStep,git,projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
import {placementRuleFixture} from './helpers/placement-rule-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
async function start(made:Awaited<ReturnType<typeof placementRuleFixture>>,id:string){made.first.enqueueTurn(reportStep({status:'progress',summary:'Owned lesson work.'}),forThread());const receipt=await made.f.json('/api/projects/project/threads',ThreadCreatedViewSchema,'POST',{schema:'thread-create-request-v1',clientRequestId:id,title:'Owned lesson '+id,task:'Change the fictional fixture.'});await made.f.waitFor(()=>made.f.app.projectWork.store.get(receipt.threadId),row=>row?.state==='idle');await made.f.app.projectWork.idle();return made.f.thread(receipt.threadId);}
test('LESSONPOL1 actual placement receives at most thirty newest enabled in-scope lessons and counts those decisions',async()=>{
 const made=await placementRuleFixture();f=made.f;
 const rows=Array.from({length:35},(_,n)=>JevLessonSchema.parse({schema:'jev-lesson-v1',key:'owned_lesson_'+n,id:'L'+(n+100),scope:n===34?'global':'project',...(n===34?{}:{projectId:n===33?'elsewhere':'project'}),about:'placement',text:'Owned lesson '+n,source:'owner',enabled:n!==32,timesApplied:0,createdAt:new Date(Date.UTC(2026,0,1,0,0,n)).toISOString()}));
 for(const row of rows)f.app.hub.put('owner-jev-lessons',row.key,JevLessonSchema,row,0);
 const thread=await start(made,'scoped'),snapshot=f.app.projectWork.jevDecisions.read('project',thread.placement.inputsRef!)!,packet=JSON.parse(snapshot.inputs.state) as {lessons?:{heading:string;items:Array<{key:string;text:string}>}};
 const eligible=rows.filter(row=>row.enabled&&(row.scope==='global'||row.projectId==='project')).reverse().slice(0,30);
 expect(packet.lessons).toEqual({schema:'jev-lesson-input-v1',heading:"Lessons from the owner's overrides",items:eligible.map(({id,key,text})=>({id,key,text}))});
 expect(made.calls[0]!.state).toMatchObject({lessons:packet.lessons});
 for(const row of rows)expect(f.app.hub.get('owner-jev-lessons',row.key,JevLessonSchema)?.document.timesApplied).toBe(Number(eligible.some(item=>item.key===row.key)));
 const before=f.app.ownerJev.lessons('project');await f.app.projectHub.jevPolicy!('project');await f.app.projectHub.jevPolicy!('project');expect(f.app.ownerJev.lessons('project')).toEqual(before);
});
test('LESSONPOL2 actual placement use counts once and prompt replay never counts as another use',async()=>{
 const made=await placementRuleFixture();f=made.f;const lesson=f.app.ownerJev.addLesson('project',{about:'placement',source:'owner',text:'Owned placement correction.'});
 await start(made,'counted');expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);
 await f.app.ownerJev.propose('project','p-v1',{edits:[{find:'Choose the model that should carry this thread end to end.',replace:'Choose the owned replay model.'}],summary:'Owned lesson replay control.'});
 expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);expect(made.first.runs).toHaveLength(1);expect(made.calls).toHaveLength(2);
});


const routeTransport:typeof fetch=async(_url,init)=>{
 if(init?.method!=='POST')return Response.json({models:[]});
 const body=JSON.parse(String(init.body)) as {questions:Record<string,{criteria:Record<string,string>}>};
 return Response.json({model:'fixture',usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>{const choice=Object.keys(q.criteria)[0]!;return[key,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,Number(k===choice)]))}];}))});
};
test('LESSONPOL3 the first landing policy read awaits correction migration and concurrent reads never duplicate lessons',async()=>{
 f=await projectFixture();f.fake.enqueueTurn(reportStep({status:'progress',summary:'Owned correction fixture.'}),forThread());
 const created=await f.app.projectWork.createThread('project',{schema:'thread-create-request-v1',clientRequestId:'migrated_lesson',title:'Owned migration fixture',task:'Preserve the fictional work.',modelId:'fixture',deviceId:f.app.device.deviceId});await f.app.projectWork.idle();
 await f.app.projectHub.putMergeDocument(LandingCorrectionSchema.parse({schema:'landing-correction-v1',id:'owned_correction',projectId:'project',deviceId:f.app.device.deviceId,threadId:created.threadId,revision:0,commit:git(f.checkout,'rev-parse','HEAD'),at:new Date().toISOString(),title:'Owned migration fixture',correction:'should-have-asked'}),0);
 const hooks=await Promise.all([f.app.ownerJev.landingHook('project'),f.app.ownerJev.landingHook('project')]);
 for(const hook of hooks)expect(hook.lessons.texts).toContain('For “Owned migration fixture”, the owner said: Should have asked me.');
 expect(f.app.ownerJev.lessons('project').filter(row=>row.source==='migrated')).toHaveLength(1);
 expect(f.app.ownerJev.lessons('project')[0]?.timesApplied).toBe(0);
});
test('LESSONPOL4 a member landing uses active l-v1, canonical lessons and complete owner rule context',async()=>{
 f=await projectFixture({control:true,jevKey:true,decisionFetch:routeTransport});
 const old=await f.app.projectHub.settings('project');await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({...old?.document??defaultProjectWorkSettings('project'),delivery:'land',autoLand:false}),old?.revision??0);
 const proposed=await f.app.ownerJev.propose('project','l-v1',{edits:[{find:'Small or low-risk change',replace:'Small owned member change'}],summary:'Owned member landing prompt.'});f.app.ownerJev.apply(proposed.match(/^P[1-9][0-9]*/u)![0]);
 const lesson=f.app.ownerJev.addLesson('project',{about:'landing',source:'owner',text:'Owned member landing lesson.'}),rule=await f.app.ownerJev.saveRule('project',{when:{label:'manual'},set:{landingRoute:'ask-owner'}});
 const member=await projectMember(f,{decisionFetch:routeTransport});member.fake.capabilities.readOnlyEnforced=true;await member.app.projectWork.moveCoordinatorHere('project');member.fake.capabilities.readOnlyEnforced=false;
 member.fake.enqueueTurn(commitStep({'README.md':'Owned member lesson fixture\n'},{status:'done',summary:'A small owned member change.'}),forThread());
 const created=await member.app.projectWork.createThread('project',{schema:'thread-create-request-v1',clientRequestId:'member_lesson',title:'Owned member landing fixture',task:'Change only the fictional fixture.',isolation:'worktree',modelId:'fixture',effort:'medium',deviceId:member.deviceId});
 await f.waitFor(()=>member.thread(created.threadId),row=>row.state==='in-review');await member.app.projectWork.idle();
 const rows=await f.app.projectWork.landings.records('project',created.threadId),route=rows.find(row=>row.schema==='landing-route-v1');
 expect(route).toMatchObject({schema:'landing-route-v1',deviceId:member.deviceId,promptVersion:2,promptText:expect.stringContaining('Small owned member change'),rawChoice:'land',route:'ask-owner',rulesApplied:[rule.id],lessons:[lesson.id],inputPacket:{corrections:[lesson.text],lessons:{heading:"Lessons from the owner's overrides",items:[{key:lesson.key,text:lesson.text}]}}});
 expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);expect(member.fake.runs).toHaveLength(1);expect(member.thread(created.threadId).landing).toBeUndefined();
},120_000);


test('LESSONUSE1 normal lesson receipts reject changed retries and foreign projects or devices',async()=>{
 const made=await placementRuleFixture();f=made.f;const lesson=f.app.ownerJev.addLesson('project',{about:'placement',source:'owner',text:'Owned receipt contract.'});const thread=await start(made,'receipt_contract'),receipt=f.app.hub.get('owner-jev-lesson-uses',thread.placement.inputsRef!,JevLessonUseSchema)!.document;
 await f.app.projectHub.recordJevLessonUse!(receipt);await f.app.projectHub.recordJevLessonUse!(receipt);expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);
 await expect(f.app.projectHub.recordJevLessonUse!({...receipt,lessonKeys:['different_lesson']})).rejects.toThrow(/different lesson inputs/u);
 await expect(f.app.projectHub.recordJevLessonUse!({...receipt,id:'foreign_device_use',deviceId:'different_device'})).rejects.toMatchObject({status:403});
 f.app.hub.put('projects','other',ProjectSchema,ProjectSchema.parse({...f.project,id:'other',name:'Other fictional project'}),0);
 await expect(f.app.projectHub.recordJevLessonUse!({...receipt,id:'foreign_project_use',projectId:'other'})).rejects.toMatchObject({status:403});
 expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);expect(f.app.hub.get('owner-jev-lesson-uses','foreign_project_use',JevLessonUseSchema)).toBeNull();
});
test('LESSONUSE2 a lost member receipt reply retries without counting the actual decision twice',async()=>{
 const made=await placementRuleFixture();f=made.f;const lesson=f.app.ownerJev.addLesson('project',{about:'placement',source:'owner',text:'Owned lost reply contract.'}),member=await projectMember(f,{decisionFetch:made.transport});member.fake.capabilities.readOnlyEnforced=true;await member.app.projectWork.moveCoordinatorHere('project');member.fake.capabilities.readOnlyEnforced=false;made.choices.device=f.app.device.deviceId;
 let lost=false;member.loseReply=call=>{if(!lost&&call.endsWith(' jev-lesson-use')){lost=true;return true;}return false;};
 const thread=await start(made,'lost_receipt');expect(lost).toBe(true);expect(thread.placement.inputsDeviceId).toBe(member.deviceId);expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);
 await member.app.projectWork.pulse();await member.app.projectWork.idle();expect(member.hubCalls.filter(call=>call.endsWith(' jev-lesson-use')).length).toBeGreaterThanOrEqual(2);expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);expect(made.first.runs).toHaveLength(1);expect(member.fake.runs).toHaveLength(0);
});
test('LESSONUSE3 an unavailable receipt write survives daemon restart and is delivered once without restarting work',async()=>{
 const made=await placementRuleFixture();f=made.f;const lesson=f.app.ownerJev.addLesson('project',{about:'placement',source:'owner',text:'Owned offline receipt contract.'});f.app.projectHub.recordJevLessonUse=async()=>{throw Error('Simulated receipt write outage.');};
 const thread=await start(made,'offline_receipt'),before=structuredClone(f.thread(thread.id));expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(0);expect(f.app.hub.get('owner-jev-lesson-uses',thread.placement.inputsRef!,JevLessonUseSchema)).toBeNull();
 await f.restart();await f.app.projectWork.pulse();await f.app.projectWork.idle();expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);expect(f.app.hub.get('owner-jev-lesson-uses',thread.placement.inputsRef!,JevLessonUseSchema)).not.toBeNull();await f.app.projectWork.pulse();expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);expect(f.thread(thread.id)).toEqual(before);expect(made.first.runs).toHaveLength(1);
});
test('LESSONLEGACY1 an older migrated lesson keeps its key and count when its original correction is seen again',async()=>{
 const made=await placementRuleFixture();f=made.f;const thread=await start(made,'legacy_migration'),at=new Date().toISOString(),legacy=JevLessonSchema.parse({schema:'jev-lesson-v1',key:'legacy_migrated_lesson',id:'L99',scope:'project',projectId:'project',about:'landing',text:'For "Owned old correction", the owner said: Should have asked me.',source:'migrated',enabled:true,timesApplied:7,createdAt:at});f.app.hub.put('owner-jev-lessons',legacy.key,JevLessonSchema,legacy,0);
 const archived=LandingCorrectionSchema.parse({schema:'landing-correction-v1',id:'owned_old_correction',projectId:'project',deviceId:f.app.device.deviceId,threadId:thread.id,revision:1,commit:git(f.checkout,'rev-parse','HEAD'),at,title:'Owned old correction',correction:'should-have-asked'});f.app.hub.put('project-merge-documents',archived.id,LandingCorrectionSchema,archived,0);
 await f.app.ownerJev.landingHook('project');await f.app.ownerJev.landingHook('project');const rows=f.app.ownerJev.lessons('project').filter(row=>row.source==='migrated');expect(rows).toHaveLength(1);expect(rows[0]).toEqual(legacy);
});


test('LESSONLEGACY2 new correction writes produce one lesson each and identical retries preserve edits',async()=>{
 const made=await placementRuleFixture();f=made.f;const thread=await start(made,'new_corrections');
 const correction=LandingCorrectionSchema.parse({schema:'landing-correction-v1',id:'new_owned_correction',projectId:'project',deviceId:f.app.device.deviceId,threadId:thread.id,revision:0,commit:git(f.checkout,'rev-parse','HEAD'),at:new Date().toISOString(),title:'Owned repeated correction',correction:'should-have-asked'});
 const first=await f.app.projectHub.putMergeDocument(correction,0);const initial=f.app.ownerJev.lessons('project').filter(row=>row.source==='migrated');expect(initial).toHaveLength(1);
 f.app.ownerJev.editLesson('project',initial[0]!.id,{text:'The owner edited this correction.',enabled:false});await f.app.projectHub.putMergeDocument(correction,0);await f.app.ownerJev.landingHook('project');expect(f.app.ownerJev.lessons('project').filter(row=>row.source==='migrated')).toHaveLength(1);expect(f.app.ownerJev.lessons('project')[0]).toMatchObject({key:initial[0]!.key,text:'The owner edited this correction.',enabled:false});
 await f.app.projectHub.putMergeDocument({...correction,id:'second_new_owned_correction'},0);expect(f.app.ownerJev.lessons('project').filter(row=>row.source==='migrated')).toHaveLength(2);expect(first.document.id).toBe(correction.id);
});

test('LESSONLEGACY3 initial migration preserves explicit hub order for equal-time archived corrections',async()=>{
 const made=await placementRuleFixture();f=made.f;const thread=await start(made,'archived_order'),at=new Date().toISOString(),commit=git(f.checkout,'rev-parse','HEAD');f.app.hub.delete('owner-jev-migrated','project');
 for(let n=0;n<10;n++){const row=LandingCorrectionSchema.parse({schema:'landing-correction-v1',id:'archived_correction_'+(9-n),projectId:'project',deviceId:f.app.device.deviceId,threadId:thread.id,revision:1,commit,at,title:'Archived correction '+n,correction:'should-have-asked',receivedOrder:n+1});f.app.hub.put('project-merge-documents',row.id,LandingCorrectionSchema,row,0);}
 const hook=await f.app.ownerJev.landingHook('project');expect(hook.lessons.texts.map(text=>Number(text.match(/Archived correction ([0-9]+)/u)?.[1]))).toEqual([9,8,7,6,5,4,3,2]);expect(f.app.ownerJev.lessons('project').every(row=>row.timesApplied===0)).toBe(true);expect(made.first.runs).toHaveLength(1);
});
