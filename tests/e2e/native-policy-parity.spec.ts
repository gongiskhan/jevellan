import {join} from 'node:path';
import type {BrowserContext} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CursorListSchema,CursorSessionSchema,CursorTranscriptSchema,NativeConversationPolicySchema,OwnerToolResultSchema} from '../../packages/core/dist/index.js';
import {projectFixture,type ProjectFixture} from '../helpers/project-fixture.js';
import {expect,test} from './fixtures.js';

async function policyClient(f:ProjectFixture){
 const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,'..','..','bin','jevellan.mjs'),'mcp'],cwd:f.checkout,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',JEVELLAN_HOME:f.homes.root},stderr:'ignore'}),client=new Client({name:'native-policy-parity',version:'1'});await client.connect(transport);
 try{const result=OwnerToolResultSchema.parse((await client.callTool({name:'config',arguments:{action:'native_policy'}})).structuredContent);expect(result.ok).toBe(true);if(!result.ok)throw new Error('Canonical native policy refused.');return{client,policy:NativeConversationPolicySchema.parse(result.data)};}catch(error){await client.close();throw error;}
}
async function signedIn(f:ProjectFixture,context:BrowserContext){
 const separator=f.cookie.indexOf('=');await context.addCookies([{name:f.cookie.slice(0,separator),value:f.cookie.slice(separator+1),url:f.base,httpOnly:true,sameSite:'Lax'}]);
}
function nativeFixture(f:ProjectFixture){
 const at=new Date().toISOString(),sessions=['cursor','claude','codex'].map((runtime,index)=>CursorSessionSchema.parse({schema:'cursor-session-v1',id:runtime+'_'+String(index+1).repeat(32),runtime,ownerDeviceId:f.app.device.deviceId,deviceName:'Simulated device',title:runtime+' fixture',cwd:null,project:'Simulated project',state:'idle',lastActivityAt:at,connected:true,canSteer:false,canSend:runtime==='cursor'}));
 f.app.cursor.list=async()=>CursorListSchema.parse({schema:'cursor-list-v1',sessions,unavailable:[],observedAt:at});
 f.app.cursor.read=async(_device,id)=>{const session=sessions.find(row=>row.id===id);if(!session)throw new Error('Unknown simulated native session.');return CursorTranscriptSchema.parse({schema:'cursor-transcript-v1',session,turns:[{id:'turn_fixture',role:'user',blocks:[{type:'text',text:'Recorded simulated native message.'}]}],messages:[],activity:[],truncated:false,observedAt:at});};
 return sessions;
}

test('NATIVEPOLICYPAR1 browser discovery and hook explanations match canonical MCP policy',async({page,context},info)=>{
 const f=await projectFixture({control:true});let client:Client|undefined;
 try{
  nativeFixture(f);const read=await policyClient(f);client=read.client;const policy=read.policy;await signedIn(f,context);await page.goto(f.base+'/settings/devices');await expect(page.locator('.cursor-connections').getByText(policy.description,{exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('native-policy-discovery.png'),fullPage:true});
  await page.getByRole('button',{name:'Review hooks for this device',exact:true}).click();await expect(page.locator('.cursor-connections details[open]').getByText(policy.hookDescription,{exact:true})).toBeVisible();const hookText=await page.locator('.cursor-connections details[open] pre code').innerText();expect(JSON.parse(hookText).hooks.stop[0].timeout).toBe(policy.hookStopTimeoutSeconds);expect(f.fake.runs).toHaveLength(0);await page.screenshot({path:info.outputPath('native-policy-hook-explanation.png'),fullPage:true});
 }finally{await client?.close().catch(()=>undefined);await f.close();}
});

test('NATIVERUNTIMEPAR1 browser labels and composer eligibility match canonical MCP runtime presentation',async({page,context},info)=>{
 const f=await projectFixture({control:true});let client:Client|undefined;
 try{
  const sessions=nativeFixture(f),read=await policyClient(f);client=read.client;await signedIn(f,context);
  for(const session of sessions){const expected=read.policy.runtimes.find(row=>row.runtime===session.runtime)!;await page.goto(f.base+'/sessions/'+session.id+'?deviceId='+f.app.device.deviceId);await expect(page.locator('.cursor-conversation .conversation-meta').getByText(expected.label,{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'Message Cursor',exact:true})).toHaveCount(expected.canCompose?1:0);await expect(page.locator('.cursor-conversation .conversation-meta').getByText('Read only',{exact:true})).toHaveCount(expected.canCompose?0:1);await expect(page.locator('.cursor-transcript')).toContainText('Recorded simulated native message.');await page.screenshot({path:info.outputPath('native-runtime-'+session.runtime+'.png'),fullPage:true});}
  expect(f.fake.runs).toHaveLength(0);
 }finally{await client?.close().catch(()=>undefined);await f.close();}
});
