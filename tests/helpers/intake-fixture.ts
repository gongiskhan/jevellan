import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {GitHubClient} from '../../packages/core/dist/index.js';
import type {ProjectFixture} from './project-fixture.js';
export async function intakePull(f:ProjectFixture,author='outside-contributor'){
 f.git(f.checkout,'switch','-c','outside-change');writeFileSync(join(f.checkout,'outside.txt'),'Contributor work.\n');f.git(f.checkout,'add','outside.txt');f.git(f.checkout,'commit','-m','Contributor change');f.git(f.checkout,'push','origin','outside-change');f.git(f.checkout,'switch','main');const client=new GitHubClient({token:async()=>f.token,baseUrl:f.github.url});const pr=await client.createPull({owner:'fixture',repo:'repo'},{title:'Outside improvement',head:'outside-change',base:'main',body:'Contributor description.'});f.github.pulls.find(row=>row.number===pr.number)!.author=author;return pr;
}
export async function intakeJob(f:ProjectFixture,command='test -f outside.txt'){
 const work=f.app.projectWork;await work.prepareDailyWork('project');const settings=await work.admission.settings('project');await f.app.projectHub.putSettings({...settings,landingChecks:[{name:'Contributor text',paths:['outside.txt'],command}],smokeCheck:'git diff --exit-code --quiet'},settings.revision);return work.daily.createJob('project',{schema:'job-create-request-v1',clientRequestId:'intake_fixture_job',name:'Intake',goalId:null,enabled:true,gate:null,run:{kind:'command',command:'intake',timeoutMinutes:30,intake:{schema:'intake-command-v1',authors:null}}});
}
export async function intakeRun(f:ProjectFixture,jobId:string,id:string){const work=f.app.projectWork;const receipt=await work.daily.runJob('project',jobId,{schema:'project-run-request-v1',clientRequestId:id});const rows=await f.waitFor(()=>work.jobs.runs('project'),runs=>runs.some(row=>row.taskId===receipt.taskId&&row.conclusion!==null));return rows.find(row=>row.taskId===receipt.taskId)!;}
export async function intakeWaiting(f:ProjectFixture,number:number){const item=(await f.app.projectHub.decisions('project')).find(row=>row.intake?.number===number&&!row.answer&&!row.withdrawnAt);if(!item)throw Error('The owned fixture has no open intake item.');return item;}
