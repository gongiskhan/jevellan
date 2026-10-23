import {afterEach,expect,test,vi} from 'vitest';
import * as core from '../packages/core/dist/index.js';
import {UiAuth} from '../packages/mesh/dist/index.js';
import {projectFixture,projectMember,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;
afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;});
const auth=(configured=false)=>({schema:'auth-state-v1',configured,authenticated:false,deviceId:'fixture_device'});

test('app sign in owns setup and login copy and canonical passphrase bounds without a credential',()=>{
 const setup=core.appSignInView(auth());expect(setup).toMatchObject({schema:'app-sign-in-view-v1',deviceId:'fixture_device',configured:false,title:'Set your passphrase',help:'Use one passphrase to sign in to Jevellan on your devices.',field:{label:'Passphrase',minLength:8,maxLength:1024,autoComplete:'new-password',hint:'At least 8 characters.'},submit:{path:'/api/auth/setup',method:'POST',waitForHub:false,label:'Set passphrase',busyLabel:'Signing in…'}});
 const login=core.appSignInView(auth(true));expect(login).toMatchObject({title:'Welcome back',help:'Sign in to your conversations and agents.',field:{autoComplete:'current-password',hint:null},submit:{path:'/api/auth/login',waitForHub:true,label:'Sign in'}});expect(Object.keys(setup).sort()).toEqual(['configured','deviceId','field','help','navigation','schema','submit','title']);
});
test('app post login preserves root and setup query strings and otherwise opens runtimes',()=>{
 const configured=core.appSignInView(auth(true)),first=core.appSignInView(auth());for(const path of ['/','/?view=overview','/setup','/setup?step=project'])expect(core.appPostLoginPath(configured,path)).toBe(path);for(const path of ['/settings/devices','/projects/project','/new','/setup-more'])expect(core.appPostLoginPath(configured,path)).toBe('/settings/runtimes');for(const path of ['/','/setup?step=account','/projects/project'])expect(core.appPostLoginPath(first,path)).toBe('/setup');
});
test('app sign in received documents reject extra fields and caller credentials',()=>{
 const model=core.appSignInView(auth());expect(core.AppSignInViewSchema.safeParse(model).success).toBe(true);expect(core.AppSignInViewSchema.safeParse({...model,passphrase:'disposable fixture text'}).success).toBe(false);expect(()=>core.appSignInView({...auth(),extra:true})).toThrow();expect(core.AppSignInViewSchema.safeParse({...model,field:{...model.field,extra:true}}).success).toBe(false);
});
test('app view projects current device roster and exact version mismatch notice',async()=>{
 f=await projectFixture({control:true});const member=await projectMember(f,{version:'0.7.2'}),roster=await member.app.roster(),hub=roster.devices.find(row=>row.device.role==='hub')!;hub.device.version='0.7.1';const view=core.appShellView(roster,{...auth(true),deviceId:member.deviceId});expect(view).toMatchObject({schema:'app-shell-view-v1',deviceId:member.deviceId,policy:{rosterPollMs:30000},devices:{schema:'devices-list-v1',currentDeviceId:member.deviceId},versionNotice:{beforeCommand:`This device runs 0.7.2. The hub runs 0.7.1. Update this device with `,command:'jevellan update',afterCommand:'.'}});expect(view.devices.devices).toEqual(roster.devices.map(row=>row.device));expect(view.roster).toEqual(roster);expect(view.signIn.deviceId).toBe(member.deviceId);
});
test('app version notice hides for equal exact versions the hub itself and missing devices',async()=>{
 f=await projectFixture({control:true});const member=await projectMember(f,{version:core.VERSION}),roster=await member.app.roster();expect(core.appVersionNotice({schema:'devices-list-v1',currentDeviceId:roster.currentDeviceId,devices:roster.devices.map(row=>row.device)})).toBeNull();const hub=roster.devices.find(row=>row.device.role==='hub')!;hub.device.version='0.7.1';const list={schema:'devices-list-v1',currentDeviceId:hub.device.id,devices:roster.devices.map(row=>row.device)};expect(core.appVersionNotice(list)).toBeNull();expect(core.appVersionNotice({...list,currentDeviceId:'missing'})).toBeNull();expect(core.appVersionNotice({...list,currentDeviceId:member.deviceId,devices:list.devices.filter(row=>row.role!=='hub')})).toBeNull();
});
test('app public sign in read uses normal auth state without creating a session',async()=>{
 f=await projectFixture({control:true});const auth=f.app.auth;if(!(auth instanceof UiAuth))throw Error('Expected fixture hub authentication.');const issue=vi.spyOn(auth,'issue');const response=await fetch(f.base+'/api/auth/view');expect(response.status).toBe(200);const view=core.AppSignInViewSchema.parse(await response.json());expect(view).toEqual(core.appSignInView(await f.app.auth.state(undefined)));expect(issue).not.toHaveBeenCalled();expect(f.fake.runs).toHaveLength(0);
});
test('app protected view and global owner read agree before any project exists',async()=>{
 f=await projectFixture({control:true});vi.spyOn(f.app.state.projects,'list').mockResolvedValue([]);const resolve=vi.spyOn(f.app.ownerTools,'resolveProject');const view=await f.json('/api/app/view',core.AppShellViewSchema);expect(view).toEqual(core.appShellView(await f.app.roster(),await f.app.auth.state(undefined)));expect(await f.app.ownerTools.call('config',{schema:'owner-tool-request-v1',caller:'cli',action:'app_view',args:{}})).toMatchObject({ok:true,data:view});expect(resolve).not.toHaveBeenCalled();expect(f.fake.runs).toHaveLength(0);
});
test('app view keeps normal owner authentication method and query guards',async()=>{
 f=await projectFixture({control:true});expect((await fetch(f.base+'/api/app/view')).status).toBe(401);expect((await f.request('/api/app/view?extra=true')).status).toBe(400);expect((await f.request('/api/app/view','POST',{})).status).toBe(405);expect((await fetch(f.base+'/api/auth/view?extra=true')).status).toBe(400);expect((await f.request('/api/auth/view','POST',{})).status).toBe(405);expect(core.AppShellViewSchema.safeParse({...await f.json('/api/app/view',core.AppShellViewSchema),extra:true}).success).toBe(false);
});
test('app member UI and headless view bind the member device rather than hub',async()=>{
 f=await projectFixture({control:true});const member=await projectMember(f),view=await member.json('/api/app/view',core.AppShellViewSchema);expect(view.deviceId).toBe(member.deviceId);expect(view.devices.currentDeviceId).toBe(member.deviceId);expect(view.signIn.deviceId).toBe(member.deviceId);const result=await f.app.ownerTools.call('config',{schema:'owner-tool-request-v1',caller:'cli',deviceId:member.deviceId,action:'app_view',args:{}});expect(result).toMatchObject({ok:true,data:view});expect(f.fake.runs).toHaveLength(0);expect(member.fake.runs).toHaveLength(0);
});
test('app member view preserves temporary peer session cleanup and does not revoke its UI session',async()=>{
 f=await projectFixture({control:true});const member=await projectMember(f),auth=f.app.auth;if(!(auth instanceof UiAuth))throw Error('Expected fixture hub authentication.');const issue=vi.spyOn(auth,'issue'),logout=vi.spyOn(auth,'logout');const result=await f.app.ownerTools.call('config',{schema:'owner-tool-request-v1',caller:'cli',deviceId:member.deviceId,action:'app_view',args:{}});expect(result.ok).toBe(true);expect(issue).toHaveBeenCalledTimes(1);expect(logout).toHaveBeenCalledTimes(1);expect((await member.request('/api/app/view')).status).toBe(200);expect((await f.request('/api/app/view')).status).toBe(200);
});

test('app version notice accepts the existing canonical workspace device projection',async()=>{
 f=await projectFixture({control:true});const workspace=await f.json('/api/config/workspace',core.SettingsWorkspaceSchema);expect(core.appVersionNotice(workspace.devices)).toBeNull();expect(()=>core.appVersionNotice({...workspace.devices,extra:true})).toThrow();
});
