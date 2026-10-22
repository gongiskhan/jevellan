import {join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {OwnerToolResultSchema,ProjectChatViewSchema,PROJECT_STREAM_POLICY} from '../../packages/core/dist/index.js';
import {projectChatFixture} from '../helpers/project-chat-fixture.js';
import {expect,test} from './fixtures.js';

test('PROJSTREAM1 browser reconnect replays coordinator history once and matches canonical MCP policy',async({page,context},info)=>{
 const made=await projectChatFixture(true),f=made.f;let client:Client|undefined;
 const streams=new Set<ServerResponse>(),track=(request:IncomingMessage,response:ServerResponse)=>{if(request.method==='GET'&&request.url?.split('?')[0]==='/api/projects/project/coordinator/events'){streams.add(response);response.once('close',()=>streams.delete(response));}};f.server.on('request',track);
 try{
  const separator=f.cookie.indexOf('=');await context.addCookies([{name:f.cookie.slice(0,separator),value:f.cookie.slice(separator+1),url:f.base,httpOnly:true,sameSite:'Lax'}]);
  const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,'..','..','bin','jevellan.mjs'),'mcp'],cwd:f.checkout,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',JEVELLAN_HOME:f.homes.root},stderr:'ignore'});client=new Client({name:'project-stream-parity',version:'1'});await client.connect(transport);
  const read=async()=>{const result=OwnerToolResultSchema.parse((await client!.callTool({name:'work',arguments:{action:'chat_view'}})).structuredContent);expect(result.ok).toBe(true);if(!result.ok)throw new Error('Canonical chat read refused.');return ProjectChatViewSchema.parse(result.data);};
  const initial=await read(),starts=f.fake.runs.length;expect(initial.streamPolicy).toEqual(PROJECT_STREAM_POLICY);await page.goto(f.base+'/projects/project');const reply=page.locator('.pw-reply').getByText('Two recorded fixture tasks.',{exact:true}),reconnecting=page.getByRole('status').filter({hasText:'Reconnecting…'});await expect(reply).toBeVisible();await expect(reconnecting).toHaveCount(0);await expect.poll(()=>streams.size).toBe(1);
  [...streams][0]!.end();await expect(reconnecting).toBeVisible();const text='A fixture notice recorded during reconnect.',notice=made.ledger.append({type:'notice',data:{schema:'project-notice-v1',kind:'info',text}}),pending=await read();expect(pending.head).toBeGreaterThan(initial.head);expect(pending.items.filter(row=>row.id===notice.id)).toEqual([{kind:'notice',id:notice.id,text,tone:'info'}]);await expect(reconnecting).toHaveCount(0);await expect(page.getByText(text,{exact:true})).toHaveCount(1);await expect(reply).toHaveCount(1);await expect.poll(()=>streams.size).toBe(1);
  const final=await read();expect(final.head).toBe(made.ledger.lastId());expect(final.items.filter(row=>row.kind==='reply'&&row.text==='Two recorded fixture tasks.')).toHaveLength(1);expect(f.fake.runs.length).toBe(starts);await page.screenshot({path:info.outputPath('project-stream-replayed-once.png'),fullPage:true});
 }finally{f.server.off('request',track);await client?.close().catch(()=>undefined);await f.close();}
});
