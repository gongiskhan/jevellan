import {expect,test} from 'vitest';
import {projectStreamState,PROJECT_STREAM_POLICY,ProjectStreamContextSchema,ProjectStreamSnapshotSchema,ProjectStreamUpdateSchema,ProjectChatViewSchema,projectChatView,type ProjectLedgerEvent,type ProjectEventFrame} from '../packages/core/dist/index.js';
const event=(id:number,text=`Reply ${id}`):ProjectLedgerEvent=>({schema:'project-ledger-event-v1',id,type:'coordinator-text',t:'2026-10-16T09:00:00.000Z',data:{schema:'coordinator-text-v1',text}});
const frame=(id:number,text?:string):ProjectEventFrame=>({schema:'project-event-v1',event:event(id,text)});
const state=(baseline?:number)=>projectStreamState({schema:'project-stream-context-v1',projectId:'project',hereDeviceId:'here',...(baseline===undefined?{}:{baseline})});
const snapshot=(lastEventId:number,coordinatorDeviceId:string|null=null,projectId='project')=>({schema:'project-stream-snapshot-v1' as const,projectId,coordinatorDeviceId,lastEventId});

test('coordinator reconnect waits grow only on refused connections and reset on open',()=>{
 const stream=state();expect(PROJECT_STREAM_POLICY).toEqual({schema:'project-stream-policy-v1',initialRetryMs:5000,maximumRetryMs:60000,retryMultiplier:2});
 expect(Array.from({length:7},()=>stream.retryDelay())).toEqual([5000,10000,20000,40000,60000,60000,60000]);stream.opened();expect(stream.retryDelay()).toBe(5000);
});
test('initial replay uses its first boundary and skipped journal cursors finish it',()=>{
 const stream=state();expect(stream.snapshot(snapshot(6))).toMatchObject({accepted:true,initial:true,moved:false,baseline:6});
 expect(stream.frame(frame(1)).events).toBeUndefined();expect(stream.frame(frame(3)).refresh).toBe(false);stream.snapshot(snapshot(20));expect(stream.cursor('{"id":4}').events).toBeUndefined();
 const update=stream.cursor('{"id":6}');expect(update.events).toEqual([event(1),event(3)]);expect(update.refresh).toBe(true);expect(stream.after).toBe(6);expect(ProjectStreamUpdateSchema.parse(update)).toEqual(update);
});
test('pending duplicates keep their latest value while live duplicates preserve identity and refresh',()=>{
 const stream=state();stream.frame(frame(2,'First'));stream.frame(frame(2,'Latest'));const first=stream.snapshot(snapshot(2)).update.events!;expect(first).toEqual([event(2,'Latest')]);
 const duplicate=stream.frame(frame(2,'Ignored'));expect(duplicate.events).toBe(first);expect(duplicate.refresh).toBe(true);const added=stream.frame(frame(1));expect(added.events).toEqual([event(1),event(2,'Latest')]);expect(stream.cursor('{"id":10}')).toMatchObject({refresh:false});expect(stream.after).toBe(10);
});
test('stream notices replace values in insertion order and activity only advances its sequence',()=>{
 const stream=state();stream.snapshot(snapshot(0));const notice=(id:number,text:string)=>({schema:'project-view-notice-v1' as const,id,decisionId:`decision_${id}`,text});
 const first=stream.frame({...frame(1),notices:[notice(3,'First')],coordinatorActivity:{schema:'project-coordinator-activity-v1',seq:5,state:'working'}});expect(first.notices).toEqual([notice(3,'First')]);
 const second=stream.frame({...frame(2),notices:[notice(2,'Second')],coordinatorActivity:{schema:'project-coordinator-activity-v1',seq:4,state:'idle'}});expect(second.coordinatorActivity).toEqual(first.coordinatorActivity);
 expect(stream.frame({...frame(3),notices:[notice(3,'Replacement')]}).notices).toEqual([notice(3,'Replacement'),notice(2,'Second')]);expect(stream.frame({...frame(4),coordinatorActivity:{schema:'project-coordinator-activity-v1',seq:6,state:'idle'}}).coordinatorActivity?.state).toBe('idle');
});
test('coordinator device moves reset overlapping ledger IDs, retry wait and withdrawal baseline',()=>{
 const stream=state();stream.snapshot(snapshot(10,'old'));stream.frame(frame(10));stream.retryDelay();stream.retryDelay();
 const moved=stream.snapshot(snapshot(2,'new'));expect(moved).toMatchObject({accepted:true,initial:false,moved:true,baseline:2});expect(moved.update.events).toBeUndefined();expect(stream.after).toBe(0);expect(stream.retryDelay()).toBe(5000);expect(stream.frame(frame(1)).events).toBeUndefined();expect(stream.frame(frame(2)).events).toEqual([event(1),event(2)]);
});
test('effect reconstruction retains an existing withdrawal baseline and first device assignment does not reset history',()=>{
 const stream=state(40);stream.frame(frame(1));const first=stream.snapshot(snapshot(1,'assigned'));expect(first).toMatchObject({initial:false,moved:false,baseline:40,update:{events:[event(1)]}});expect(stream.snapshot(snapshot(9,'assigned')).baseline).toBe(40);
});
test('foreign snapshots cannot change the source or retry state and an empty moved source publishes immediately',()=>{
 const stream=state();stream.snapshot(snapshot(1,'old'));stream.frame(frame(1));expect(stream.snapshot(snapshot(99,'other','foreign'))).toMatchObject({accepted:false,initial:false,moved:false});expect(stream.after).toBe(1);expect(stream.snapshot(snapshot(0,'new'))).toMatchObject({moved:true,baseline:0,update:{events:[]}});
});
test('legacy cursor coercion and malformed-frame behavior remain explicit',()=>{
 const stream=state();stream.snapshot(snapshot(3));expect(stream.cursor('{"id":"3"}').events).toEqual([]);expect(stream.cursor('{"id":1.5}').refresh).toBe(false);expect(stream.cursor('{"id":null}').refresh).toBe(false);stream.cursor('{"id":-4}');expect(stream.after).toBe(3);expect(()=>stream.cursor('{')).toThrow();expect(()=>stream.frame({...frame(4),unexpected:true})).toThrow();
});
test('stream context and snapshots are versioned strict documents',()=>{
 expect(ProjectStreamContextSchema.safeParse({schema:'project-stream-context-v1',projectId:'project',hereDeviceId:'here',baseline:0}).success).toBe(true);expect(ProjectStreamContextSchema.safeParse({schema:'project-stream-context-v1',projectId:'project',hereDeviceId:'here',extra:true}).success).toBe(false);expect(ProjectStreamSnapshotSchema.safeParse({...snapshot(0),extra:true}).success).toBe(false);expect(ProjectStreamUpdateSchema.safeParse({schema:'project-stream-update-v1',refresh:false,extra:true}).success).toBe(false);
});
test('canonical bounded chat reads publish shared stream policy while older views remain readable',()=>{
 const view=projectChatView({schema:'project-chat-source-v1',projectId:'project',deviceId:'here',head:0,threads:[],events:[]});expect(view.streamPolicy).toEqual(PROJECT_STREAM_POLICY);expect(view.streamPolicy).toBeDefined();const {streamPolicy,...old}=view;expect(ProjectChatViewSchema.safeParse(old).success).toBe(true);expect(ProjectChatViewSchema.safeParse({...view,streamPolicy:{...streamPolicy,unexpected:true}}).success).toBe(false);
});
