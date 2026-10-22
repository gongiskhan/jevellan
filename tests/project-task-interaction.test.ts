import {afterEach,expect,test,vi} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import type {ProjectWorkTask} from '../packages/core/dist/index.js';
import {task as fixtureTask,goal as fixtureGoal} from './helpers/owner-fixtures.js';
import {taskInteractionFixture} from './helpers/task-interaction-fixture.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;});

const task=(id:string,patch:Partial<ProjectWorkTask>={})=>fixtureTask(id,id,{projectId:'project',...patch});
const request=(patch:Record<string,unknown>={})=>({schema:'project-task-queue-request-v1',scope:'all',grouped:false,grouping:'order',...patch});
function queue(tasks:ProjectWorkTask[],order=tasks.map(row=>row.id)){
 return core.ProjectTaskQueueViewSchema.parse({schema:'project-task-queue-view-v1',scopes:{all:{order,groups:[{label:'Asks',taskIds:order}]},proposed:{order:tasks.filter(row=>row.state==='draft').map(row=>row.id),groups:[]}},rows:tasks.map(row=>({taskId:row.id,stateLabel:row.state,meta:'Fixture task.',goalNotice:null,threadLine:null,waitingLine:null}))});
}
function policy(){const context=Reflect.get(core,'projectTaskContext'),view=Reflect.get(core,'projectTaskQueueInteraction'),edit=Reflect.get(core,'projectTaskEditView'),draft=Reflect.get(core,'projectTaskDraft'),drop=Reflect.get(core,'projectTaskQueueDrop');for(const fn of[context,view,edit,draft,drop])expect(fn).toBeTypeOf('function');return{context,view,edit,draft,drop};}
const intent=(context:unknown,intent:unknown)=>({schema:'project-task-intent-v1',context,intent});

test('task interaction policy owns the original queue state actions and captured revisions',()=>{
 const p=policy(),tasks=[task('draft',{state:'draft'}),task('queued'),task('active',{state:'active'}),task('review',{state:'in-review'})],model=p.view({projectId:'project',tasks,queue:queue(tasks)},request());
 expect(model).toMatchObject({schema:'project-task-queue-interaction-v1',projectId:'project',order:tasks.map(row=>row.id),showGrouping:false});
 expect(model.rows[0]!.actions.map(row=>row.id)).toEqual(['approve','reject','now','edit','cancel','top','bottom','earlier','later']);expect(model.rows[1]!.actions.map(row=>row.id)).toEqual(['now','edit','cancel','top','bottom','earlier','later']);expect(model.rows.slice(2).map(row=>row.actions)).toEqual([[],[]]);
 expect(model.rows[0]!.context).toMatchObject({schema:'project-task-context-v1',projectId:'project',taskId:'draft',revision:1,state:'draft',held:false,dispatching:false});expect(model.rows[0]!.actions.find(row=>row.id==='reject')!.confirmation).toMatchObject({title:'Reject "draft"?',action:'Reject',consequence:'Rejected tasks stay in the project history.'});
});

test('task interaction policy retains held now dispatch editing cancellation and move boundaries',()=>{
 const p=policy(),tasks=[task('now',{now:true}),task('held',{now:true,held:true}),task('reserved',{dispatchText:'A reserved fixture start.'}),task('linked',{threadId:'thread_fixture',dispatchText:'A reserved linked start.'})],model=p.view({projectId:'project',tasks,queue:queue(tasks)},request());
 expect(model.rows[0]!.actions.find(row=>row.id==='now')!).toMatchObject({label:'Later',intent:{kind:'action',action:'later'}});expect(model.rows[1]!.actions.find(row=>row.id==='now')!).toMatchObject({label:'Start now',intent:{kind:'action',action:'now'}});
 expect(model.rows[2]!.actions.some(row=>row.id==='edit')).toBe(false);expect(model.rows[2]!.actions.find(row=>row.id==='cancel')!.enabled).toBe(false);expect(model.rows[3]!.actions.some(row=>row.id==='edit')).toBe(false);expect(model.rows[3]!.actions.find(row=>row.id==='cancel')!.enabled).toBe(true);
 expect(model.rows[0]!.actions.find(row=>row.id==='earlier')!.enabled).toBe(false);expect(model.rows[3]!.actions.find(row=>row.id==='later')!.enabled).toBe(false);expect(model.rows[1]!.actions.find(row=>row.id==='earlier')!.intent).toEqual({kind:'move',position:{before:'now'}});expect(model.rows[1]!.actions.find(row=>row.id==='later')!.intent).toEqual({kind:'move',position:{after:'reserved'}});
 expect(p.drop(model,'held','now',false)).toMatchObject({schema:'project-task-intent-v1',context:{taskId:'held',revision:1},intent:{kind:'move',position:{before:'now'}}});expect(p.drop(model,'unknown','now',true)).toBeNull();
});

test('task interaction policy shares explicit scope grouping and missing-row behavior without changing source order',()=>{
 const p=policy(),tasks=[task('one',{state:'draft'}),task('two')],source=queue(tasks,['two','missing','one']),prior=structuredClone(source),model=p.view({projectId:'project',tasks,queue:source},request({grouped:true,grouping:'goals'}));
 expect(model.order).toEqual(['two','one']);expect(model.groups).toEqual([{label:'Asks',taskIds:['two','one']}]);expect(model.showGrouping).toBe(true);expect(p.view({projectId:'project',tasks,queue:source},request({scope:'proposed'})).order).toEqual(['one']);expect(source).toEqual(prior);expect(()=>p.view({projectId:'other',tasks,queue:source},request())).toThrow(/project/iu);expect(()=>p.view({projectId:'project',tasks,queue:source},{...request(),extra:true})).toThrow();
});

test('task interaction policy keeps edit defaults canonical limits all goal choices and a retained unavailable goal',()=>{
 const p=policy(),current=task('edit',{goalId:'gone_goal'}),goals=[{goal:fixtureGoal('done','Done goal',{projectId:'project',state:'done'})},{goal:fixtureGoal('paused','Paused goal',{projectId:'project',state:'paused'})}],model=p.edit(current,goals);
 expect(model).toMatchObject({schema:'project-task-edit-view-v1',projectId:'project',taskId:'edit',context:{revision:1},defaults:{title:'edit',brief:'edit.',type:'feature',goalId:'gone_goal'},limits:{title:120,brief:20000},labels:{title:'Edit task',save:'Save',cancel:'Cancel'}});expect(model.types).toEqual(core.TaskTypeSchema.options);expect(model.goals).toEqual([{id:'',label:'Asks'},{id:'done',label:'Done goal'},{id:'paused',label:'Paused goal'}]);
});

test('task interaction policy prepares exact canonical bodies with the original revision and no refreshed context',()=>{
 const p=policy(),context=p.context(task('edit',{revision:7})),fields={title:'  Edited fixture  ',brief:'  Preserve the original writer.  ',type:'fix',goalId:''},before=structuredClone(fields),prepared=p.draft('project','edit',intent(context,{kind:'edit',fields}));
 expect(prepared).toMatchObject({schema:'project-task-draft-v1',command:{schema:'project-task-command-v1',projectId:'project',taskId:'edit',operation:'update',body:{schema:'task-update-request-v1',expectedRevision:7,title:'Edited fixture',brief:'Preserve the original writer.',type:'fix',goalId:null}}});expect(fields).toEqual(before);
 expect(p.draft('project','edit',intent(context,{kind:'move',position:'top'})).command.body).toEqual({schema:'task-update-request-v1',expectedRevision:7,position:'top'});expect(p.draft('project','edit',intent(context,{kind:'action',action:'now'})).command.body).toEqual({schema:'task-action-request-v1',expectedRevision:7,action:'now'});expect(()=>p.draft('project','other',intent(context,{kind:'move',position:'bottom'}))).toThrow(/task/iu);
});

test('task interaction policy preserves legacy read contexts while refusing invalid or unavailable preparation',()=>{
 const p=policy(),legacy=task('legacy',{revision:0}),context=p.context(legacy);expect(p.edit(legacy,[]).context.revision).toBe(0);expect(()=>p.draft('project','legacy',intent(context,{kind:'action',action:'now'}))).toThrow();
 const active=p.context(task('active',{state:'active'})),reserved=p.context(task('reserved',{dispatchText:'A reserved fixture start.'}));expect(()=>p.draft('project','active',intent(active,{kind:'move',position:'top'}))).toThrow();expect(()=>p.draft('project','reserved',intent(reserved,{kind:'action',action:'cancel'}))).toThrow();expect(()=>p.draft('project','legacy',{...intent(context,{kind:'action',action:'now'}),extra:true})).toThrow();
});

test('task interaction policy normal HTTP and owner models prepare the same canonical edit and refuse stale reuse',async()=>{
 const made=await taskInteractionFixture();f=made.f;const id=made.queued.id,before=await made.work.taskList('project'),starts=f.fake.runs.length;
 const response=await f.request('/api/projects/project/tasks/queue-view','POST',request());expect(response.status).toBe(200);const view=await response.json();expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'queue_view',args:{project:'project',request:request()}})).toMatchObject({ok:true,data:view});
 const editorResponse=await f.request(`/api/projects/project/tasks/${id}/editor`);expect(editorResponse.status).toBe(200);const editor=await editorResponse.json();expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'task_edit_view',args:{project:'project',task:id}})).toMatchObject({ok:true,data:editor});
 const input=intent(editor.context,{kind:'edit',fields:{...editor.defaults,title:'  Edited via shared task draft  ',type:'fix'}}),draftResponse=await f.request(`/api/projects/project/tasks/${id}/draft`,'POST',input);expect(draftResponse.status).toBe(200);const draft=await draftResponse.json();expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'task_draft',args:{project:'project',task:id,request:input}})).toMatchObject({ok:true,data:draft});expect(await made.work.taskList('project')).toEqual(before);
 const saved=await f.request(`/api/projects/project/tasks/${id}/command`,'POST',draft.command);expect(saved.status).toBe(200);const after=(await saved.json()).task;expect(after).toMatchObject({title:'Edited via shared task draft',type:'fix',revision:made.queued.revision+1});expect((await f.request(`/api/projects/project/tasks/${id}/command`,'POST',draft.command)).status).toBe(409);expect(await made.work.tasks.read('project',id)).toEqual(after);expect(f.fake.runs.length).toBe(starts);
});

test('task interaction policy preparation preserves a captured revision after newer edits and binds both resources',async()=>{
 const made=await taskInteractionFixture();f=made.f;const id=made.queued.id,editor=await(await f.request(`/api/projects/project/tasks/${id}/editor`)).json();expect(editor.schema).toBe('project-task-edit-view-v1');
 const update=await f.request(`/api/projects/project/tasks/${id}/edit`,'POST',{schema:'task-update-request-v1',expectedRevision:made.queued.revision,title:'Newer outside edit'});expect(update.status).toBe(200);const current=(await update.json()).task,input=intent(editor.context,{kind:'move',position:'top'}),prepared=await f.request(`/api/projects/project/tasks/${id}/draft`,'POST',input);expect(prepared.status).toBe(200);const draft=await prepared.json();expect(draft.command.body.expectedRevision).toBe(made.queued.revision);
 expect((await f.request(`/api/projects/project/tasks/${id}/command`,'POST',draft.command)).status).toBe(409);expect((await f.request(`/api/projects/project/tasks/${made.proposed.id}/command`,'POST',draft.command)).status).toBe(409);expect((await f.request(`/api/projects/project/tasks/${id}/draft`,'POST',{...input,extra:true})).status).toBe(400);expect(await made.work.tasks.read('project',id)).toEqual(current);
});

test('task interaction policy member command uses its existing coordinator and preserves hub and sibling work',async()=>{
 f=await projectFixture({coordinator:true});const member=await projectMember(f);await member.app.projectHub.assignCoordinator('project',member.deviceId,0);
 const work=member.app.projectWork,current=(await work.settingsView('project')).settings,{schema:_s,projectId:_p,revision,...settings}=current;void _s;void _p;await work.putSettings('project',{schema:'project-work-settings-request-v1',revision,settings:{...settings,status:'paused'}});
 const original=await work.tasks.save(task('member_task',{revision:0,held:true})),sibling=await work.tasks.save(task('member_sibling',{revision:0,held:true})),editorResponse=await member.request(`/api/projects/project/tasks/${original.id}/editor`);expect(editorResponse.status).toBe(200);const editor=await editorResponse.json();
 const draft=await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'task_draft',args:{project:'project',task:original.id,request:intent(editor.context,{kind:'edit',fields:{...editor.defaults,title:'Member task stays here'}})}});expect(draft.ok).toBe(true);if(!draft.ok)throw new Error('The simulated task draft was refused.');const command=(draft.data as{command:unknown}).command,local=vi.spyOn(f.app.projectWork,'updateTask'),remote=vi.spyOn(work,'updateTask');
 const result=await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'task_command',args:{project:'project',task:original.id,request:command}});expect(result).toMatchObject({ok:true,data:{schema:'task-view-v1',task:{id:original.id,projectId:'project',title:'Member task stays here'}}});expect(remote).toHaveBeenCalledTimes(1);expect(local).not.toHaveBeenCalled();expect(await work.tasks.read('project',sibling.id)).toEqual(sibling);expect(f.fake.runs.length).toBe(0);expect(member.fake.runs.length).toBe(0);
});
