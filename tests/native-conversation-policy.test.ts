import {afterEach,expect,test,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import * as core from '../packages/core/dist/index.js';
import {projectFixture,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;});

test('native conversation policy exposes canonical discovery followup and runtime presentation',()=>{
 const policy=core.nativeConversationPolicy();expect(policy).toMatchObject({schema:'native-conversation-policy-v1',historyDays:5,historyMs:432000000,followupHours:7,followupMs:25200000,hookStopTimeoutSeconds:25260});
 expect(policy.description).toBe('Cursor, Claude Code and Codex sessions from the last five days appear alongside your conversations, with formatted history and activity indicators. Claude Code and Codex are read-only.');
 expect(policy.hookDescription).toContain('up to seven hours.');expect(policy.runtimes).toEqual(['cursor','claude','codex'].map(runtime=>core.nativeRuntimePresentation(runtime)));
});
test('native runtime presentation preserves labels composer eligibility and legacy fallback',()=>{
 expect(core.nativeRuntimePresentation()).toMatchObject({schema:'native-runtime-presentation-v1',runtime:'cursor',label:'Cursor',canCompose:true,readOnlyLabel:null});expect(core.nativeRuntimePresentation('cursor')).toMatchObject({label:'Cursor',canCompose:true});
 expect(core.nativeRuntimePresentation('claude')).toMatchObject({label:'Claude Code',canCompose:false,readOnlyLabel:'Read only'});expect(core.nativeRuntimePresentation('codex')).toMatchObject({label:'Codex',canCompose:false,readOnlyLabel:'Read only'});expect(core.nativeRuntimePresentation('future')).toMatchObject({label:'Cursor',canCompose:false});
});
test('native policy documents are strict and refuse inconsistent duration facts',()=>{
 expect(core.NativeConversationPolicySchema).toBeDefined();const policy=core.nativeConversationPolicy();expect(()=>core.NativeConversationPolicySchema.parse({...policy,extra:true})).toThrow();expect(()=>core.NativeConversationPolicySchema.parse({...policy,historyMs:1})).toThrow();expect(()=>core.NativeConversationPolicySchema.parse({...policy,followupHours:0})).toThrow();expect(()=>core.NativeRuntimePresentationSchema.parse({...policy.runtimes[0],extra:true})).toThrow();
});
test('native policy readers receive independent snapshots',()=>{
 const first=core.nativeConversationPolicy();first.runtimes[0]!.label='Changed locally';first.historyDays=1;expect(core.nativeConversationPolicy()).toMatchObject({historyDays:5,runtimes:[{label:'Cursor'},{label:'Claude Code'},{label:'Codex'}]});
});
test('native policy API and owner tool agree without reading native sessions or running work',async()=>{
 f=await projectFixture({control:true});const list=vi.spyOn(f.app.cursor,'list');const response=await f.request('/api/cursor/policy');expect(response.status).toBe(200);const policy=core.NativeConversationPolicySchema.parse(await response.json());expect(policy).toEqual(core.nativeConversationPolicy());
 const tool=await f.app.ownerTools.call('config',{schema:'owner-tool-request-v1',caller:'cli',action:'native_policy',args:{}});expect(tool).toMatchObject({ok:true,data:policy});expect(list).not.toHaveBeenCalled();expect(f.fake.runs).toHaveLength(0);
});
test('native policy HTTP keeps normal owner authentication and method guards',async()=>{
 f=await projectFixture({control:true});expect((await fetch(f.base+'/api/cursor/policy')).status).toBe(401);const response=await f.request('/api/cursor/policy','POST',{});expect(response.status).toBe(405);expect(f.fake.runs).toHaveLength(0);
});
test('native hook policy preserves the existing stop grace without modifying configuration',async()=>{
 f=await projectFixture({control:true});const policy=core.nativeConversationPolicy(),path=f.homes.at('cursor','connections.json'),before=existsSync(path)?readFileSync(path):null;const setup=f.app.cursor.hookSetup(f.app.device.deviceId),configuration=JSON.parse(setup.configuration);expect(configuration.hooks.stop[0]).toMatchObject({timeout:policy.followupMs/1000+60,loop_limit:null});expect(configuration.hooks.postToolUse[0].timeout).toBe(10);expect(existsSync(path)?readFileSync(path):null).toEqual(before);
});
test('native policy is an explicit read action within the existing twelve owner tools',()=>{
 expect(core.OWNER_TOOLS).toHaveLength(12);expect(core.OWNER_TOOLS.find(tool=>tool.name==='config')!.actions.find(action=>action.name==='native_policy')).toMatchObject({access:'read'});
});
