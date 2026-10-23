import {ProjectWorkSettingsSchema,defaultProjectWorkSettings} from '../../packages/core/dist/index.js';
import {forThread} from '../../packages/runtime-contract/dist/index.js';
import {commitStep,git,projectFixture} from '../helpers/project-fixture.js';
import {expect,test} from './fixtures.js';

test('ROUTEPAR1 a stored owner route clamp is shown and a correction saves without landing work',async({page,context},info)=>{
 const transport:typeof fetch=async(_url,init)=>{
  if(init?.method!=='POST')return Response.json({models:[]});
  const body=JSON.parse(String(init.body)) as {questions:Record<string,{criteria:Record<string,string>}>};
  return Response.json({model:'fixture',usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>{const choice=Object.keys(q.criteria)[0]!;return[key,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,Number(k===choice)]))}];}))});
 };
 const f=await projectFixture({jevKey:true,decisionFetch:transport});
 try{
  const old=await f.app.projectHub.settings('project');await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({...old?.document??defaultProjectWorkSettings('project'),delivery:'land',autoLand:false}),old?.revision??0);
  await f.app.ownerJev.saveRule('project',{set:{landingRoute:'ask-owner'},note:'Owned route browser fixture.'});
  f.fake.enqueueTurn(commitStep({'README.md':'Owned route browser work\n'},{status:'done',summary:'A small route fixture.'}),forThread());
  const created=await f.app.projectWork.createThread('project',{schema:'thread-create-request-v1',clientRequestId:'route_browser',title:'Owned route browser work',task:'Make the fictional change.',modelId:'fixture',deviceId:f.app.device.deviceId});
  await f.waitFor(()=>f.thread(created.threadId),row=>row.state==='in-review');await f.app.projectWork.idle();
  const before=structuredClone(f.thread(created.threadId)),head=git(f.origin,'rev-parse','main');
  const separator=f.cookie.indexOf('=');await context.addCookies([{name:f.cookie.slice(0,separator),value:f.cookie.slice(separator+1),url:f.base,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(f.base+'/projects/project/threads/'+created.threadId);await page.getByRole('button',{name:'Why this landing',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Why this landing',exact:true});await expect(panel).toContainText('ask-owner');await expect(panel).toContainText('R1 changed the landing route');
  await page.screenshot({path:info.outputPath('stored-owner-route.png'),fullPage:true});
  await panel.getByRole('button',{name:"Didn't need asking",exact:true}).click();await expect(panel.getByRole('status')).toContainText('Saved for future landing decisions.');
  await page.screenshot({path:info.outputPath('route-correction-saved.png'),fullPage:true});
  const records=await f.app.projectWork.landings.records('project',created.threadId);expect(records.some(row=>row.schema==='landing-correction-v1'&&row.correction==='did-not-need-asking')).toBe(true);
  expect(f.thread(created.threadId)).toEqual(before);expect(git(f.origin,'rev-parse','main')).toBe(head);expect(f.fake.runs).toHaveLength(1);
  const lesson=f.app.ownerJev.lessons('project').find(row=>row.source==='migrated')!;expect(lesson).toBeDefined();expect(lesson.timesApplied).toBe(0);
  f.fake.enqueueTurn(commitStep({'README.md':'Owned later lesson work\n'},{status:'done',summary:'A later fictional change.'}),forThread());
  const later=await f.app.projectWork.createThread('project',{schema:'thread-create-request-v1',clientRequestId:'route_browser_lesson',title:'Owned later lesson work',task:'Make the next fictional change.',isolation:'worktree',modelId:'fixture',effort:'medium',deviceId:f.app.device.deviceId});
  await f.waitFor(()=>f.thread(later.threadId),row=>row.state==='in-review');await f.app.projectWork.idle();
  const laterRoute=(await f.app.projectWork.landings.records('project',later.threadId)).find(row=>row.schema==='landing-route-v1');expect(laterRoute).toMatchObject({lessons:[lesson.id],inputPacket:{corrections:[lesson.text],lessons:{items:[{key:lesson.key,text:lesson.text}]}}});expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);
  await page.goto(f.base+'/projects/project/threads/'+later.threadId);await page.getByRole('button',{name:'Why this landing',exact:true}).click();const laterPanel=page.getByRole('dialog',{name:'Why this landing',exact:true});await laterPanel.getByText('Changed files and corrections',{exact:true}).click();await expect(laterPanel).toContainText(lesson.text);await page.screenshot({path:info.outputPath('later-decision-lesson-input.png'),fullPage:true});
  expect(f.thread(created.threadId)).toEqual(before);expect(git(f.origin,'rev-parse','main')).toBe(head);expect(f.fake.runs).toHaveLength(2);
 }finally{await f.close();}
});
