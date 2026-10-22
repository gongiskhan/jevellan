import {taskInteractionFixture} from './task-interaction-fixture.js';
import {task} from './owner-fixtures.js';
import {seedProjectChat} from './project-chat-fixture.js';
/** Four proposed tasks in a paused isolated project; every action queues work without starting a provider. */
export async function projectChatCardsFixture(control=false){
 const made=await taskInteractionFixture(control);
 try{
  const proposed=await made.work.tasks.save({...made.proposed,held:undefined}),queued=await made.work.tasks.save({...made.queued,state:'draft',held:undefined}),third=await made.work.tasks.save(task('third_fixture','Third fixture',{projectId:'project',revision:0,state:'draft',rank:'6'})),fourth=await made.work.tasks.save(task('fourth_fixture','Fourth fixture',{projectId:'project',revision:0,state:'draft',rank:'a'})),tasks=[proposed,queued,third,fourth];
  return{...made,proposed,queued,third,fourth,tasks,...seedProjectChat(made.work,tasks.map(row=>row.id),{summary:'Four recorded tasks.',reply:'Four recorded fixture tasks.'})};
 }catch(error){await made.f.close();throw error;}
}
