import {projectFixture} from './project-fixture.js';
import {task} from './owner-fixtures.js';

/** All providers and project work are simulated; pause the owned fixture before seeding its queue. */
export async function taskInteractionFixture(control=false){
 const f=await projectFixture({coordinator:true,control});
 try{
  const work=f.app.projectWork;await work.coordinators.ensureAssigned('project');
  const current=(await work.settingsView('project')).settings,{schema:_s,projectId:_p,revision,...settings}=current;void _s;void _p;
  await work.putSettings('project',{schema:'project-work-settings-request-v1',revision,settings:{...settings,status:'paused'}});
  const proposed=await work.tasks.save(task('proposed_fixture','Proposed fixture',{projectId:'project',revision:0,state:'draft',held:true,rank:'4'})),queued=await work.tasks.save(task('queued_fixture','Queued fixture',{projectId:'project',revision:0,state:'queued',held:true,rank:'c'}));
  return{f,work,projectId:'project',proposed,queued};
 }catch(error){await f.close();throw error;}
}
