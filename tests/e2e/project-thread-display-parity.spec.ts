import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {OwnerToolResultSchema,ThreadCreatedViewSchema,ThreadViewSchema,threadDisplayValue} from '../../packages/core/dist/index.js';
import {forThread} from '../../packages/runtime-contract/dist/index.js';
import {projectFixture,reportStep} from '../helpers/project-fixture.js';
import {expect,test} from './fixtures.js';

test('THREADDISPLAYPAR1 browser locale timestamps share canonical MCP display parts without changing stored text',async({page,context},info)=>{
 const f=await projectFixture({control:true});let client:Client|undefined;
 try{
  const at='2026-10-22T04:00:00.000Z',reason='Wait until '+at,notice='A recorded notice at '+at;
  f.fake.enqueueTurn(reportStep({status:'progress',summary:'Recorded display fixture ready.'}),forThread());
  const made=await f.json('/api/projects/project/threads',ThreadCreatedViewSchema,'POST',{schema:'thread-create-request-v1',clientRequestId:'thread_display_browser_fixture',title:'Thread display fixture',task:'Inspect the simulated display.'});
  await f.waitFor(()=>f.thread(made.threadId),row=>row.state==='idle');f.app.projectWork.store.update(made.threadId,row=>({...row,stateReason:reason}));
  f.app.projectWork.ledgers.thread('project',made.threadId).append({type:'notice',data:{schema:'project-notice-v1',kind:'info',text:notice}});const stored=f.ledgerText(made.threadId);
  const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,'..','..','bin','jevellan.mjs'),'mcp'],cwd:f.checkout,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',JEVELLAN_HOME:f.homes.root},stderr:'ignore'});
  client=new Client({name:'thread-display-parity',version:'1'});await client.connect(transport);
  const result=OwnerToolResultSchema.parse((await client.callTool({name:'thread',arguments:{action:'view',thread:made.threadId}})).structuredContent);expect(result.ok).toBe(true);if(!result.ok)throw new Error('Canonical display read refused.');const canonical=ThreadViewSchema.parse(result.data);
  expect(canonical.presentation?.reason?.display).toMatchObject({schema:'project-thread-display-text-v1',text:reason,parts:[{kind:'text',value:'Wait until '},{kind:'time',value:at}]});expect(canonical.notices?.at(-1)?.display).toMatchObject({text:notice,parts:[{kind:'text',value:'A recorded notice at '},{kind:'time',value:at}]});
  const separator=f.cookie.indexOf('=');await context.addCookies([{name:f.cookie.slice(0,separator),value:f.cookie.slice(separator+1),url:f.base,httpOnly:true,sameSite:'Lax'}]);await page.goto(f.base+`/projects/project/threads/${made.threadId}`);
  const local=await page.evaluate(value=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}),at);
  await expect(page.locator('.pw-thread-reason')).toHaveText(threadDisplayValue(reason,canonical.presentation!.reason!.display,()=>local));await expect(page.locator('.pw-thread-reason')).toHaveAttribute('title',reason);
  await page.screenshot({path:info.outputPath('thread-display-local-reason.png'),fullPage:true});
  await page.getByRole('button',{name:'Model and account details',exact:true}).click();await page.locator('#thread-session-information summary').filter({hasText:'Session notices'}).click();
  await expect(page.locator('#thread-session-information details[open] li').last()).toContainText(threadDisplayValue(notice,canonical.notices!.at(-1)!.display,()=>local));expect(f.thread(made.threadId).stateReason).toBe(reason);expect(f.ledgerText(made.threadId)).toBe(stored);expect(f.fake.turnStarts).toHaveLength(1);
  await page.screenshot({path:info.outputPath('thread-display-local-notice.png'),fullPage:true});
 }finally{await client?.close().catch(()=>undefined);await f.close();}
});
