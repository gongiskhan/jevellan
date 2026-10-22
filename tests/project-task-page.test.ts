import {afterEach,expect,test} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {task,thread,at,sha} from './helpers/owner-fixtures.js';
import {taskInteractionFixture} from './helpers/task-interaction-fixture.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
function projector(){const fn=Reflect.get(core,'projectTaskPageView');expect(fn).toBeTypeOf('function');return fn;}
const pr={number:17,url:'https://github.com/fixture/repo/pull/17',state:'open' as const,headSha:sha('a'),checks:'passing' as const,mergeable:'clean' as const,updatedAt:at(1)};

test('task page view shares the exact polling association and navigation without changing source records',()=>{
 const make=projector(),current=task('task_one','A linked fixture',{projectId:'project',threadId:'thread_one',type:'fix',state:'in-review',endNote:'Keep the recorded note.'}),threads=[thread('unrelated','Other fixture',{projectId:'project',pr:{...pr,number:18}}),thread('thread_one','Matching fixture',{projectId:'project',pr})],before=structuredClone({current,threads}),view=make('project',current,threads);
 expect(view).toMatchObject({schema:'project-task-page-view-v1',projectId:'project',taskId:current.id,task:current,meta:'fix · in-review',policy:{schema:'project-task-page-policy-v1',pollHintMs:30000,loadingLabel:'Loading task…'},back:{label:'Back to project',href:'/projects/project'},threadLink:{label:'Open thread',id:'thread_one',href:'/projects/project/threads/thread_one'},pullRequest:{threadId:'thread_one',number:17,url:pr.url,state:'open',headSha:pr.headSha,label:'#17 · open'}});expect({current,threads}).toEqual(before);
});

test('task page view preserves absent indexes no PR and first matching thread behavior',()=>{
 const make=projector(),current=task('task_one','Fixture',{projectId:'project',threadId:'thread_one'}),missing=make('project',current,[]);expect(missing.pullRequest).toBeNull();expect(missing.threadLink).toMatchObject({id:'thread_one',href:'/projects/project/threads/thread_one'});
 const first=thread('thread_one','First fixture',{projectId:'project'}),later=thread('thread_one','Later duplicate',{projectId:'project',pr});expect(make('project',current,[first,later]).pullRequest).toBeNull();expect(make('project',{...current,threadId:null},[later])).toMatchObject({threadLink:null,pullRequest:null});
});

test('task page view and versioned documents bind the task project and refuse extra or mismatched fields',()=>{
 const make=projector(),current=task('task_one','Fixture',{projectId:'project',threadId:'thread_one'});expect(()=>make('other',current,[])).toThrow(/project/iu);expect(()=>make('project',current,[thread('thread_one','Foreign fixture',{projectId:'other',pr})])).toThrow(/project/iu);
 const schema=Reflect.get(core,'ProjectTaskPageViewSchema'),view=make('project',current,[]);expect(schema).toHaveProperty('parse');expect(()=>schema.parse({...view,extra:true})).toThrow();expect(()=>schema.parse({...view,taskId:'other_task'})).toThrow();expect(()=>schema.parse({...view,policy:{...view.policy,extra:true}})).toThrow();expect(()=>schema.parse({...view,schema:'project-task-page-view-v0'})).toThrow();
});

test('task page normal API and owner read share the scoped snapshot without mutation or worker starts',async()=>{
 const made=await taskInteractionFixture();f=made.f;const before=await made.work.taskList('project'),starts=f.fake.runs.length,response=await f.request(`/api/projects/project/tasks/${made.queued.id}/page-view`);expect(response.status).toBe(200);const view=await response.json();expect(view).toMatchObject({schema:'project-task-page-view-v1',projectId:'project',taskId:made.queued.id,task:made.queued,threadLink:null,pullRequest:null});
 expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'task_page_view',args:{project:'project',task:made.queued.id}})).toMatchObject({ok:true,data:view});expect((await f.request(`/api/projects/project/tasks/${made.queued.id}/page-view`,'POST',{})).status).toBe(405);expect((await f.request('/api/projects/project/tasks/missing_task/page-view')).status).toBe(404);expect((await f.request(`/api/projects/other_project/tasks/${made.queued.id}/page-view`)).status).toBe(404);expect(await made.work.taskList('project')).toEqual(before);expect(f.fake.runs.length).toBe(starts);
});

test('task page member and hub owner read the same task without moving or starting its work',async()=>{
 f=await projectFixture({coordinator:true});const member=await projectMember(f);await member.app.projectHub.assignCoordinator('project',member.deviceId,0);const work=member.app.projectWork,current=(await work.settingsView('project')).settings,{schema:_s,projectId:_p,revision,...settings}=current;void _s;void _p;await work.putSettings('project',{schema:'project-work-settings-request-v1',revision,settings:{...settings,status:'paused'}});
 const original=await work.tasks.save(task('member_task','Member fixture',{projectId:'project',revision:0,held:true,rank:'8'})),response=await member.request(`/api/projects/project/tasks/${original.id}/page-view`);expect(response.status).toBe(200);const view=await response.json();expect(view).toMatchObject({schema:'project-task-page-view-v1',task:original,policy:{pollHintMs:30000}});expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'task_page_view',args:{project:'project',task:original.id}})).toMatchObject({ok:true,data:view});expect(await work.tasks.read('project',original.id)).toEqual(original);expect(f.fake.runs.length).toBe(0);expect(member.fake.runs.length).toBe(0);
});
