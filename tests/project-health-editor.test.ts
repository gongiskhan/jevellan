import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
const ids=Array.from({length:10},(_,i)=>'health_candidate_'+i);
const check=()=>core.ProjectHealthCheckSchema.parse({id:'health_original',name:'Synthetic app',steps:[{name:'Answers',method:'GET',url:'https://example.invalid/health',expectStatus:[200]}]});
const editor=()=>core.healthEditor('project',[check()],ids);
const edit=(model:ReturnType<typeof editor>,command:Record<string,unknown>)=>core.healthEditorEdit(model,{schema:'health-editor-command-v1',...command});
const run=(id:string,at:string,passed=true)=>core.ProjectHealthRunSchema.parse({schema:'project-health-run-v1',id,projectId:'project',checkId:'health_original',at,trigger:'manual',passed,steps:[{name:'Answers',passed,status:passed?200:500,ms:3,...(!passed?{reason:'status 500, expected [200]'}:{})}]});

test('health editor owns exact defaults limits and candidate check identities',()=>{
 const model=editor();expect(model).toMatchObject({schema:'health-editor-v1',projectId:'project',limits:{checks:10,steps:5,name:80,url:500,body:2000,expectBody:200,timeout:{min:1000,max:30000}},newStep:{name:'The app answers',method:'GET',url:'https://',headers:'{}',body:'',expectStatus:'200',expectBody:'',timeoutMs:'10000'},apply:{enabled:true,errors:[]},patch:[check()]});
 const added=edit(model,{operation:'add-check'});expect(added.fields[1]).toMatchObject({id:ids[0],name:'New check',enabled:true,steps:[model.newStep]});expect(added.apply.enabled).toBe(false);expect(model.fields).toHaveLength(1);
});
test('health editor keeps incomplete URL status timeout and headers text editable without canonical writes',()=>{
 let model=editor();for(const patch of [{url:'https://'},{expectStatus:'200,not-a-code'},{timeoutMs:''},{headers:'{'}]){model=edit(model,{operation:'step',checkId:'health_original',index:0,patch});expect(model.apply.enabled).toBe(false);expect(model.patch).toBeNull();expect(model.fields[0]!.steps[0]).toMatchObject(patch);}
});
test('health editor parses statuses null fields method and timeout once without trimming body text',()=>{
 const model=edit(editor(),{operation:'step',checkId:'health_original',index:0,patch:{method:'POST',expectStatus:'200, 201',timeoutMs:'1500',body:'  raw payload  ',expectBody:'',headers:'{"Accept":"text/plain"}'}});expect(model.patch?.[0]?.steps[0]).toMatchObject({method:'POST',expectStatus:[200,201],timeoutMs:1500,body:'  raw payload  ',expectBody:null,headers:{Accept:'text/plain'}});expect(model.apply.enabled).toBe(true);
});
test('health editor returns exact no-sign-in HTTPS and headers JSON refusals',()=>{
 for(const [patch,message]of [[{url:'http://example.invalid/'},'Health checks use https (http only for localhost).'],[{url:'https://name:password@example.invalid/'},'Health checks never sign in.'],[{headers:'{"Authorization":"fixture"}'},'Health checks never sign in. Remove the Authorization header.'],[{headers:'[]'},'Headers must be a JSON object of text values.']]as const){const model=edit(editor(),{operation:'step',checkId:'health_original',index:0,patch});expect(model.apply.errors.map(row=>row.message)).toContain(message);expect(model.patch).toBeNull();}
});
test('health editor guards ten checks five steps and the last retained step without replacing ids',()=>{
 let model=editor();for(let i=0;i<9;i++)model=edit(model,{operation:'add-check'});expect(model.canAddCheck).toBe(false);expect(()=>edit(model,{operation:'add-check'})).toThrow();expect(new Set(model.fields.map(row=>row.id)).size).toBe(10);
 model=editor();expect(()=>edit(model,{operation:'remove-step',checkId:'health_original',index:0})).toThrow();for(let i=0;i<4;i++)model=edit(model,{operation:'add-step',checkId:'health_original'});expect(model.checks[0]).toMatchObject({canAddStep:false,canRemoveStep:true});expect(()=>edit(model,{operation:'add-step',checkId:'health_original'})).toThrow();expect(edit(model,{operation:'remove-step',checkId:'health_original',index:2}).fields[0]!.steps).toHaveLength(4);
});
test('health editor removal reuses only an unused engine candidate and retains other check fields',()=>{
 const added=edit(editor(),{operation:'add-check'}),changed=edit(added,{operation:'check',checkId:'health_original',patch:{name:'  Synthetic name  ',enabled:false}}),removed=edit(changed,{operation:'remove-check',checkId:ids[0]});expect(removed.fields[0]).toMatchObject({id:'health_original',name:'  Synthetic name  ',enabled:false});expect(edit(removed,{operation:'add-check'}).fields.map(row=>row.id)).toEqual(['health_original',ids[1]]);
});
test('health editor preview documents are strict and canonical duplicate oversized or invalid fields stay refused',()=>{
 const model=editor(),request={schema:'health-editor-preview-v1',projectId:'project',fields:model.fields};expect(core.HealthEditorPreviewSchema.safeParse(request).success).toBe(true);expect(core.HealthEditorPreviewSchema.safeParse({...request,history:[]}).success).toBe(false);expect(()=>edit(model,{operation:'step',checkId:'health_original',index:0,patch:{method:'DELETE'}})).toThrow();expect(()=>edit(model,{operation:'check',checkId:'health_original',patch:{id:'replaced'}})).toThrow();expect(core.healthEditorPreview({...request,fields:[...model.fields,...model.fields]},ids).apply.enabled).toBe(false);expect(edit(model,{operation:'step',checkId:'health_original',index:0,patch:{timeoutMs:'999'}}).patch).toBeNull();
});
test('health run plan validates only the requested draft and preserves its unsaved fields',()=>{
 let model=edit(editor(),{operation:'add-check'});model=edit(model,{operation:'check',checkId:'health_original',patch:{name:'Unsaved check',enabled:false}});expect(model.apply.enabled).toBe(false);expect(core.healthRunRequest(model,'health_original')).toMatchObject({schema:'project-health-request-v1',project:'project',operation:'run',definition:{...check(),name:'Unsaved check',enabled:false}});expect(()=>core.healthRunRequest(model,ids[0]!)).toThrow();expect(()=>core.healthRunRequest(model,'missing')).toThrow();
});
test('health history merges new receipts once sorts newest first and exposes the latest five per check',()=>{
 const source=Array.from({length:7},(_,i)=>run('run_'+i,new Date(i*1000).toISOString(),i!==6));const view=core.healthHistoryView({schema:'project-health-view-v1',projectId:'project',runs:source});expect(view.runs.map(row=>row.runId)).toEqual(['run_6','run_5','run_4','run_3','run_2','run_1','run_0']);const merged=core.healthHistoryMerge('project',source,{schema:'project-health-view-v1',projectId:'project',runs:[source[6]!]});expect(merged).toHaveLength(7);const displayed=core.healthRecentRuns(view,'health_original');expect(displayed).toHaveLength(5);expect(displayed[0]).toMatchObject({label:'Failed',at:source[6]!.at,steps:['Answers: failed · 3 ms · status 500, expected [200]']});expect(displayed[1]!.steps).toEqual(['Answers: passed · 3 ms · status 200']);
});
test('health history binds project and run scopes and does not invent an absent status code',()=>{
 const entry=run('run_scope',new Date(0).toISOString());expect(()=>core.healthHistoryMerge('project',[],{schema:'project-health-view-v1',projectId:'other',runs:[]})).toThrow();expect(()=>core.healthHistoryView({schema:'project-health-view-v1',projectId:'project',runs:[{...entry,projectId:'other'}]})).toThrow();expect(core.healthHistoryView({schema:'project-health-view-v1',projectId:'project',runs:[{...entry,steps:[{name:'Answers',passed:true,ms:0}]}]}).runs[0]!.steps).toEqual(['Answers: passed · 0 ms']);
});
test('health HTTP and config owner previews share raw validation and engine minted ids without saving',async()=>{
 f=await projectFixture({control:true});const model=await f.json('/api/projects/project/config/health-editor',core.HealthEditorSchema);expect(model).toMatchObject({projectId:'project',fields:[],canAddCheck:true});expect(model.candidateIds).toHaveLength(10);const next=edit(model,{operation:'add-check'}),preview=await f.json('/api/projects/project/config/health-editor',core.HealthEditorSchema,'POST',{schema:'health-editor-preview-v1',projectId:'project',fields:next.fields});expect(preview.fields).toEqual(next.fields);expect(preview.patch).toBeNull();expect(await f.app.ownerTools.call('config',{schema:'owner-tool-request-v1',caller:'cli',project:'project',action:'health_preview',args:{request:{schema:'health-editor-preview-v1',projectId:'project',fields:next.fields}}})).toMatchObject({ok:true,data:{fields:next.fields,patch:null}});expect((await f.app.projectWork.settingsView('project')).settings.healthChecks).toEqual([]);expect(f.fake.runs).toHaveLength(0);
});
test('health member editor and history use authoritative state point and reject mismatched preview scope',async()=>{
 f=await projectFixture({control:true});const member=await projectMember(f);const model=await member.json('/api/projects/project/config/health-editor',core.HealthEditorSchema);expect(model.projectId).toBe('project');expect(await member.json('/api/projects/project/health/view',core.HealthHistoryViewSchema)).toMatchObject({projectId:'project',runs:[]});const response=await f.request('/api/projects/project/config/health-editor','POST',{schema:'health-editor-preview-v1',projectId:'other',fields:[]});expect(response.status).toBe(400);expect(()=>member.app.hub).toThrow('A member has no authoritative hub database.');expect(f.fake.runs).toHaveLength(0);
});

test('health editor never reuses a retired check identity and requests a fresh pool after exhaustion',()=>{
 let model=editor();for(let index=0;index<10;index++){model=edit(model,{operation:'add-check'});const id=model.fields.at(-1)!.id;expect(id).toBe(ids[index]);model=edit(model,{operation:'remove-check',checkId:id});expect(model.fields).toHaveLength(1);}
 expect(model).toMatchObject({canAddCheck:true,needsCandidate:true,retiredIds:ids});expect(()=>edit(model,{operation:'add-check'})).toThrow('Refresh health check identities.');const fresh=core.healthEditorPreview({schema:'health-editor-preview-v1',projectId:'project',fields:model.fields},ids.map(id=>id+'_fresh'));expect(edit(fresh,{operation:'add-check'}).fields.at(-1)!.id).toBe(ids[0]+'_fresh');
});
