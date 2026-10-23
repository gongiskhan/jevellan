import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {JevReplaySummarySchema,OwnerToolResultSchema} from '../../packages/core/dist/index.js';
import {forThread} from '../../packages/runtime-contract/dist/index.js';
import {git,reportStep} from '../helpers/project-fixture.js';
import {placementRuleFixture} from '../helpers/placement-rule-fixture.js';
import {expect,test} from './fixtures.js';

test('LESSONPAR1 MCP edits and replays a lesson while the browser preserves the original placement',async({page,context},info)=>{
 const made=await placementRuleFixture(),f=made.f,lesson=f.app.ownerJev.addLesson('project',{about:'placement',source:'owner',text:'Owned browser original lesson.'});let client:Client|undefined;
 try{
  client=new Client({name:'lesson-replay-browser-parity',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,'..','..','bin','jevellan.mjs'),'mcp'],cwd:f.checkout,env:{PATH:process.env.PATH??'',HOME:join(f.root,'user'),JEVELLAN_HOME:f.homes.root,JEVELLAN_PROJECT:'project'},stderr:'ignore'}));
  const call=async(action:string,args:Record<string,unknown>={})=>{const reply=await client!.callTool({name:'jev',arguments:{action,...args}});expect(reply.isError).not.toBe(true);if(reply.structuredContent!==undefined){const result=OwnerToolResultSchema.parse(reply.structuredContent);if(!result.ok)throw Error('Owned lesson command refused.');return result;}return{schema:'owner-tool-result-v1' as const,ok:true as const,text:CallToolResultSchema.parse(reply).content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),data:undefined};};
  const separator=f.cookie.indexOf('=');await context.addCookies([{name:f.cookie.slice(0,separator),value:f.cookie.slice(separator+1),url:f.base,httpOnly:true,sameSite:'Lax'}]);made.first.enqueueTurn(reportStep({status:'progress',summary:'Owned lesson replay browser work.'}),forThread());
  await page.goto(f.base+'/projects/project');await page.getByRole('button',{name:'New task',exact:true}).click();const dialog=page.getByRole('dialog',{name:'New task',exact:true});await dialog.getByRole('textbox',{name:'Title',exact:true}).fill('Owned lesson replay browser work');await dialog.getByRole('textbox',{name:'Brief',exact:true}).fill('Change only the fictional fixture.');await dialog.getByRole('button',{name:'Add to queue',exact:true}).click();await expect(dialog).toHaveCount(0);
  const rows=await f.waitFor(()=>f.app.projectWork.store.list('project'),threads=>threads.some(row=>row.title==='Owned lesson replay browser work'&&row.state==='idle')),thread=rows.find(row=>row.title==='Owned lesson replay browser work')!,before=structuredClone(f.thread(thread.id)),head=git(f.origin,'rev-parse','main'),repo=f.app.projectWork.jevDecisions,source=repo.read('project',thread.placement.inputsRef!)!;
  // The two extra historical sources are fixture copies; there is one actual worker journey.
  for(let n=1;n<3;n++){const at=new Date(Date.parse(source.at)+n).toISOString();repo.record({...source,id:repo.id(at),at});}
  await page.goto(f.base+'/projects/project/threads/'+thread.id);await page.getByRole('button',{name:'Model and account details',exact:true}).click();await page.getByRole('button',{name:'Why',exact:true}).click();const panel=page.getByRole('dialog',{name:'Why this placement',exact:true});await expect(panel).toContainText('Small fixture');await page.screenshot({path:info.outputPath('original-placement-before-lesson-replay.png'),fullPage:true});
  await call('lesson_edit',{lesson:lesson.id,text:'Owned browser proposed lesson.'});made.choices.pick_model='large';made.choices.effort='high';const calls=made.calls.length,replayed=await call('replay',{lesson:lesson.id,n:3});expect(replayed.text).toContain(`Replay on the last 3 decisions that used ${lesson.id}: 3 would change.`);expect(made.calls.length-calls).toBe(3);const summary=f.app.hub.list('owner-jev-replays',JevReplaySummarySchema).map(row=>row.document).find(row=>row.questionSet==='lessons'&&row.lessonId===lesson.id)!,read=await call('replay_report',{report:summary.id});expect(JevReplaySummarySchema.parse(read.data)).toMatchObject({selected:3,compared:3,changed:3,evidence:'simulated'});
  await expect(panel).toContainText('Small fixture');await page.screenshot({path:info.outputPath('original-placement-after-lesson-replay.png'),fullPage:true});expect(repo.read('project',source.id)).toEqual(source);expect(f.thread(thread.id)).toEqual(before);expect(git(f.origin,'rev-parse','main')).toBe(head);expect(made.first.runs).toHaveLength(1);expect(made.second.runs).toHaveLength(0);expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);
 }finally{await client?.close().catch(()=>undefined);await f.close();}
});
