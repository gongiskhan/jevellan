import {afterEach,expect,test} from 'vitest';
import {projectFixture,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
const input=(clientRequestId:string)=>({schema:'job-create-request-v1',clientRequestId,name:'Intake',goalId:null,enabled:false,gate:null,interval:{everyMinutes:10,start:'08:00',end:'23:00'},run:{kind:'command',command:'intake',timeoutMinutes:30,intake:{schema:'intake-command-v1',authors:null}}});
test('intake configuration is an explicit command operation with the prescribed schedule and no required device tag',async()=>{
 f=await projectFixture();const work=f.app.projectWork;await work.prepareDailyWork('project');const job=await work.daily.createJob('project',input('intake_configuration'));expect(job).toMatchObject({enabled:false,interval:{everyMinutes:10,start:'08:00',end:'23:00'},run:{kind:'command',command:'intake',needs:[],intake:{schema:'intake-command-v1',authors:null}}});expect(f.github.requests.some(row=>row.path.includes('/pulls'))).toBe(false);expect(f.fake.runs).toHaveLength(0);
});
test('intake author configuration survives ordinary revision checked job edits',async()=>{
 f=await projectFixture();const work=f.app.projectWork;await work.prepareDailyWork('project');const request=input('intake_authors'),job=await work.daily.createJob('project',{...request,run:{...request.run,intake:{schema:'intake-command-v1',authors:['outside-contributor']}}});const editor=await work.routineEditor('project','job',job.id);const saved=await work.saveRoutineEditor('project',job.id,{...editor.request.base,fields:{...editor.defaults,name:'External changes'}},'job');expect(saved).toBeDefined();const fresh=(await f.app.projectHub.job(job.id))!.document;expect(fresh.run).toMatchObject({kind:'command',intake:{schema:'intake-command-v1',authors:['outside-contributor']}});expect(f.github.requests.some(row=>row.path.includes('/pulls'))).toBe(false);
});
test('an ordinary command named Intake has no implicit external pull request capability',async()=>{
 f=await projectFixture();const work=f.app.projectWork;await work.prepareDailyWork('project');const job=await work.daily.createJob('project',{...input('ordinary_intake_name'),run:{kind:'command',command:'true',timeoutMinutes:1}});expect(job.run).not.toHaveProperty('intake');expect(f.github.requests.some(row=>row.path.includes('/pulls'))).toBe(false);
});
