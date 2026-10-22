import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {OwnerToolResultSchema,ProjectChatViewSchema} from '../../packages/core/dist/index.js';
import {forCoordinator} from '../../packages/runtime-contract/dist/index.js';
import {projectFixture} from '../helpers/project-fixture.js';
import {expect,test} from './fixtures.js';

test('CHATPAR1 browser coordinator send and recorded chat match canonical MCP headings and delivery',async({page,context},info)=>{
 const f=await projectFixture({coordinator:true,control:true});let client:Client|undefined;
 try{
  const words='Please record the fixture request.',reply='A fresh fixture response.';f.fake.enqueueTurn(turn=>{turn.say(reply);return{status:'completed'};},forCoordinator);
  const separator=f.cookie.indexOf('=');await context.addCookies([{name:f.cookie.slice(0,separator),value:f.cookie.slice(separator+1),url:f.base,httpOnly:true,sameSite:'Lax'}]);await page.goto(f.base+'/projects/project');const composer=page.getByRole('textbox',{name:'Message the coordinator',exact:true});await composer.fill(words);await composer.press('Enter');await expect(page.locator('.pw-reply').getByText(reply,{exact:true})).toBeVisible();await f.app.projectWork.idle('project');
  const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,'..','..','bin','jevellan.mjs'),'mcp'],cwd:f.checkout,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',JEVELLAN_HOME:f.homes.root},stderr:'ignore'});client=new Client({name:'project-chat-parity',version:'1'});await client.connect(transport);const result=OwnerToolResultSchema.parse((await client.callTool({name:'work',arguments:{action:'chat_view'}})).structuredContent);expect(result.ok).toBe(true);if(!result.ok)throw new Error('Canonical project chat refused.');const view=ProjectChatViewSchema.parse(result.data),owner=view.items.find(row=>row.kind==='owner'&&row.text===words);expect(owner?.kind).toBe('owner');if(owner?.kind!=='owner')throw new Error('The canonical owner record is missing.');expect(owner.delivered).toBe(true);
  const card=page.locator('.pw-owner').filter({hasText:words});await expect(card.locator('.message-heading strong')).toHaveText(owner.heading);await expect(card.locator('.pw-pending')).toHaveCount(0);await expect(page.locator('.pw-reply').getByText(reply,{exact:true})).toHaveCount(1);expect(view.items.filter(row=>row.kind==='owner'&&row.text===words)).toHaveLength(1);expect(view.items.filter(row=>row.kind==='reply'&&row.text===reply)).toHaveLength(1);
  const first=OwnerToolResultSchema.parse((await client.callTool({name:'work',arguments:{action:'chat_view',request:{...view.request,limit:1}}})).structuredContent);expect(first.ok).toBe(true);if(!first.ok)throw new Error('Canonical project chat page refused.');expect(ProjectChatViewSchema.parse(first.data)).toMatchObject({projectId:'project',deviceId:view.deviceId,request:{throughEventId:view.request.throughEventId,deviceId:view.deviceId,offset:0,limit:1},items:[view.items[0]],nextOffset:1,hasMore:true});expect(f.fake.turnStarts.filter(turn=>turn.owner.kind==='coordinator').length).toBe(1);expect(f.fake.turnStarts.filter(turn=>turn.owner.kind==='thread').length).toBe(0);await page.screenshot({path:info.outputPath('project-chat-shared-send.png'),fullPage:true});
 }finally{await client?.close().catch(()=>undefined);await f.close();}
});
