import{afterEach,expect,test,vi}from'vitest';
import*as core from'../packages/core/dist/index.js';
import{projectFixture,projectMember,type ProjectFixture}from'./helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;});
const context=core.ContextViewSchema.parse({schema:'project-context-v1',projectId:'project',state:'none',fingerprint:'a'.repeat(64),claudeReadsAgents:false,files:['AGENTS.md','CLAUDE.md'].map(name=>({name,kind:'missing',tracked:false,hash:'a'.repeat(64),content:''}))});
const change=(status:'planned'|'completed')=>core.GitBranchChangeSchema.parse({schema:'git-branch-change-v1',from:'fixture-branch',to:'main',status,created:true,createdRemote:false,before:'a'.repeat(40),after:'b'.repeat(40)});
const operation=(status:core.ContextOperation['status'],reason?:string,branchChange?:core.GitBranchChange)=>core.ContextOperationSchema.parse({schema:'context-operation-v1',id:'setup',projectId:'project',conversationId:'setup_conversation',workId:'setup_work',createdAt:'2026-10-01T00:00:00Z',request:{schema:'context-request-v1',clientRequestId:'setup',revision:1,fingerprint:context.fingerprint,choice:'create'},before:context,generation:1,status,reason,branchChange});
const panel=(busy:boolean,operations:core.ContextOperation[]=[])=>core.ContextPanelSchema.parse({schema:'context-panel-v1',context,revision:1,busy,operations});
const prepare=(value=panel(false),deviceId='owner')=>{const fn=Reflect.get(core,'projectSetupView');expect(fn).toBeTypeOf('function');return fn({schema:'project-setup-facts-v1',projectId:'project',deviceId,panel:value});};
const wait=()=>{const fn=Reflect.get(core,'waitForProjectSetupViews');expect(fn).toBeTypeOf('function');return fn;};

test('project setup view preserves busy priority, first unfinished refusal and completed/cancelled readiness',()=>{
 expect(prepare(panel(true,[operation('completed')]))).toMatchObject({schema:'project-setup-view-v1',state:'waiting',pollMs:500,refusal:null});expect(prepare(panel(false,[operation('completed'),operation('cancelled')]))).toMatchObject({state:'ready',refusal:null});expect(prepare(panel(false,[operation('blocked','First reason'),{...operation('requested','Second reason'),id:'second'}]))).toMatchObject({state:'blocked',refusal:'Project setup needs attention. Open Context in Settings → Projects. First reason'});expect(prepare(panel(false,[operation('draft-ready')])).refusal).toBe('Project setup needs attention. Open Context in Settings → Projects.');
});

test('project setup view selects the latest recorded branch change even when setup is already ready',()=>{
 const first={...operation('completed',undefined,change('planned')),id:'first'},last={...operation('completed',undefined,change('completed')),id:'last'};expect(prepare(panel(false,[first,last]))).toMatchObject({state:'ready',branchChange:change('completed')});expect(prepare(panel(false))).toMatchObject({branchChange:null});
});

test('project setup view engine wait keeps500ms cadence, suppresses duplicate changes and reports completion once',async()=>{
 const read=vi.fn().mockResolvedValueOnce(prepare(panel(true,[operation('applying',undefined,change('planned'))]))).mockResolvedValueOnce(prepare(panel(true,[operation('applying',undefined,change('planned'))]))).mockResolvedValueOnce(prepare(panel(true,[operation('completed',undefined,change('completed'))]))).mockResolvedValueOnce(prepare(panel(false,[operation('completed',undefined,change('completed'))])));const waiting=vi.fn(),branchChanged=vi.fn(),completed=vi.fn(),pause=vi.fn(async(milliseconds:number)=>{expect(milliseconds).toBe(500);});const result=await wait()(read,new AbortController().signal,{waiting,branchChanged,completed},pause);expect(result.state).toBe('ready');expect(read).toHaveBeenCalledTimes(4);expect(pause).toHaveBeenCalledTimes(3);expect(waiting).toHaveBeenCalledTimes(3);expect(branchChanged.mock.calls.map(row=>row[0])).toEqual([change('planned'),change('completed')]);expect(completed).toHaveBeenCalledExactlyOnceWith(change('completed'));
});

test('project setup view engine wait refuses blocked or changed identity and abandons late reads after abort',async()=>{
 await expect(wait()(async()=>prepare(panel(false,[operation('blocked','Preserve work')])),new AbortController().signal)).rejects.toThrow('Open Context in Settings → Projects. Preserve work');const read=vi.fn().mockResolvedValueOnce(prepare(panel(true))).mockResolvedValueOnce({...prepare(),deviceId:'another'});await expect(wait()(read,new AbortController().signal,{},async()=>undefined)).rejects.toThrow('another project or device');let resolve!:(value:unknown)=>void;const late=new Promise<unknown>(done=>{resolve=done;}),controller=new AbortController(),notified=vi.fn();const pending=wait()(()=>late,controller.signal,{branchChanged:notified});const stopped=expect(pending).rejects.toMatchObject({name:'AbortError'});controller.abort();resolve(prepare(panel(false,[operation('completed',undefined,change('completed'))])));await stopped;expect(notified).not.toHaveBeenCalled();
});

test('project setup view normal HTTP and tool reuse canonical context state without creating work',async()=>{
 f=await projectFixture();const response=await f.request('/api/projects/project/setup-view');expect(response.status).toBe(200);const view=await response.json();expect(view).toMatchObject({schema:'project-setup-view-v1',projectId:'project',deviceId:f.app.device.deviceId,state:'ready',branchChange:null,refusal:null,pollMs:500});expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',action:'project_setup',args:{project:'project'}})).toMatchObject({ok:true,data:view});expect((await f.app.conversations.list()).conversations).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});

test('project setup view member UI and headless reads use member setup rather than hub setup',async()=>{
 f=await projectFixture();const member=await projectMember(f),hub=await f.app.conversations.contextPanel('project');vi.spyOn(f.app.conversations,'contextPanel').mockResolvedValue({...hub,busy:true});const response=await member.request('/api/projects/project/setup-view');expect(response.status).toBe(200);const view=await response.json();expect(view).toMatchObject({state:'ready',deviceId:member.deviceId});expect(await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'cli',deviceId:member.deviceId,action:'project_setup',args:{project:'project'}})).toMatchObject({ok:true,data:view});expect(f.fake.starts).toHaveLength(0);expect(member.fake.starts).toHaveLength(0);
});

test('project setup view bounded normal wait follows the same engine policy and preserves unfinished state',async()=>{
 f=await projectFixture();const before=await f.app.conversations.contextPanel('project');let reads=0;vi.spyOn(f.app.conversations,'contextPanel').mockImplementation(async()=>({...before,busy:++reads<3}));const response=await f.request('/api/projects/project/setup-wait','POST',{schema:'project-setup-wait-request-v1',waitSeconds:2});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'ready'});expect(reads).toBe(3);expect(f.fake.starts).toHaveLength(0);expect((await f.app.conversations.list()).conversations).toHaveLength(0);
});

test('project setup view preserves owner/peer authentication, strict inputs and method bounds',async()=>{
 f=await projectFixture();expect((await fetch(f.base+'/api/projects/project/setup-view')).status).toBe(401);expect((await f.request('/api/projects/project/setup-view?extra=true')).status).toBe(400);expect((await f.request('/api/projects/project/setup-view','POST',{})).status).toBe(405);expect((await f.request('/api/projects/project/setup-wait')).status).toBe(405);expect((await f.request('/api/projects/project/setup-wait','POST',{schema:'project-setup-wait-request-v1',waitSeconds:31})).status).toBe(400);expect((await fetch(f.base+'/api/mesh/project-definitions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({schema:'project-definition-peer-request-v1',operation:'setup-view',projectId:'project'})})).status).toBe(401);expect(f.fake.starts).toHaveLength(0);
});
