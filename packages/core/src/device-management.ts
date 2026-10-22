import {z} from 'zod';
import {IdSchema,CleanupSummarySchema} from './schemas.js';
import {DeviceRosterSchema,DeviceViewSchema,DeviceSwitchSchema,DeviceTagsInputSchema,DeviceSettingsInputSchema,JoinInvitationSchema,DeviceOriginSchema} from './mesh-schemas.js';
import {WorktreeDiskSchema,WorktreeCleanupInputSchema} from './worktree-disk-schemas.js';
import {CleanupStateSchema} from './cleanup-schemas.js';
import {CLEANUP_INTRO} from './cleanup-editor.js';
const text=z.string(),count=z.number().int().nonnegative();
const field=z.strictObject({label:text,value:text,maxLength:count,enabled:z.boolean(),placeholder:text,help:text.nullable(),saveLabel:text});
const readiness=z.strictObject({beforeCommand:text,command:text,afterCommand:text});
export const DeviceManagementFactsSchema=z.strictObject({schema:z.literal('device-management-facts-v1'),roster:DeviceRosterSchema,now:count});
export const DeviceManagementRowSchema=z.strictObject({schema:z.literal('device-management-row-v1'),deviceId:IdSchema,name:text,current:z.boolean(),revoked:z.boolean(),roleLabel:text,osLabel:text,versionLine:text,
 available:z.boolean(),canSwitch:z.boolean(),canClean:z.boolean(),appsOnly:z.boolean(),worktrees:z.strictObject({path:text,inspectLabel:text,removeLabel:text,unavailableNotice:text}),tags:field,protectedPaths:field,
 presence:z.strictObject({tone:z.enum(['ready','checking','missing']),label:text,at:text.nullable()}),runningLine:text,
 sessions:z.array(z.strictObject({runtimeLabel:text,folder:text,lastActivityAt:text,minutesAgo:count})),readiness:z.array(readiness),factsLine:text.nullable(),workLine:text.nullable(),lastCleanup:CleanupSummarySchema.nullable()});
export const DeviceManagementViewSchema=z.strictObject({schema:z.literal('device-management-view-v1'),currentDeviceId:IdSchema,devices:z.array(DeviceManagementRowSchema),cleanupDeviceIds:z.array(IdSchema),cleanupIntro:text});
export const DeviceReadRequestSchema=z.strictObject({schema:z.literal('device-read-request-v1'),deviceId:IdSchema});
export type DeviceManagementView=z.infer<typeof DeviceManagementViewSchema>;
export type DeviceManagementRow=z.infer<typeof DeviceManagementRowSchema>;
const tagsAction=z.strictObject({schema:z.literal('device-action-v1'),operation:z.literal('tags'),input:DeviceTagsInputSchema});
const pathsAction=z.strictObject({schema:z.literal('device-action-v1'),operation:z.literal('paths'),input:DeviceSettingsInputSchema});
const cleanAction=z.strictObject({schema:z.literal('device-action-v1'),operation:z.literal('clean'),input:z.strictObject({deviceId:IdSchema})});
const orphanAction=z.strictObject({schema:z.literal('device-action-v1'),operation:z.literal('orphans'),input:z.strictObject({deviceId:IdSchema,selection:WorktreeCleanupInputSchema})});
const inviteAction=z.strictObject({schema:z.literal('device-action-v1'),operation:z.literal('invite'),input:z.strictObject({schema:z.literal('empty-request-v1')})});
export const DeviceActionSchema=z.discriminatedUnion('operation',[tagsAction,pathsAction,cleanAction,orphanAction,inviteAction]);
export type DeviceAction=z.infer<typeof DeviceActionSchema>;
const gb=(bytes:number)=>`${Number((bytes/1e9).toFixed(1))} GB`;
const cleanupSize=(bytes:number)=>bytes>=1e9?`${(bytes/1e9).toFixed(2)} GB`:bytes>=1e6?`${(bytes/1e6).toFixed(1)} MB`:`${Math.ceil(bytes/1000)} KB`;
export function deviceAvailable(raw:unknown,currentDeviceId:string){const row=DeviceViewSchema.parse(raw);return !row.revoked&&(row.device.id===currentDeviceId||row.status!=='offline');}
const runtimes={claude:'Claude Code',codex:'Codex',cursor:'Cursor',gemini:'Gemini'};
export function deviceManagementView(raw:unknown):DeviceManagementView{
 const {roster,now}=DeviceManagementFactsSchema.parse(raw);
 return DeviceManagementViewSchema.parse({schema:'device-management-view-v1',currentDeviceId:roster.currentDeviceId,cleanupDeviceIds:roster.devices.filter(row=>!row.revoked).map(row=>row.device.id),cleanupIntro:CLEANUP_INTRO,devices:roster.devices.map(row=>{
  const device=row.device,here=device.id===roster.currentDeviceId,available=deviceAvailable(row,roster.currentDeviceId),facts=row.heartbeat?.facts,power=facts?.power;
  const readiness:z.infer<typeof DeviceManagementRowSchema>['readiness']=[];
  if(device.role==='hub'&&power?.status==='available'&&power.acSleepMinutes>0)readiness.push({beforeCommand:`Hub readiness: this Mac can sleep on AC power after ${power.acSleepMinutes} minutes. Nightly work may stop. Run `,command:'sudo pmset -c sleep 0',afterCommand:' on the hub, then check again.'});
  if(device.role==='hub'&&power?.status==='unavailable')readiness.push({beforeCommand:'Hub readiness: AC power settings could not be read. Check them with ',command:'pmset -g custom',afterCommand:' on the hub.'});
  const running=row.heartbeat?.runningConversations.length??0;
  return {schema:'device-management-row-v1',deviceId:device.id,name:device.name,current:here,revoked:row.revoked,roleLabel:device.role==='hub'?'Hub':'Member',osLabel:device.os==='darwin'?'macOS':'Linux',versionLine:`Version ${device.version}`,available,canSwitch:!here&&available,canClean:!row.revoked&&(here||row.status==='online'),appsOnly:device.workPolicy?.mode==='apps-only',worktrees:{path:`/api/devices/${device.id}/worktrees`,inspectLabel:'Inspect worktrees',removeLabel:'Remove orphaned worktrees',unavailableNotice:'Worktree usage is unavailable.'},
   tags:{label:'Device tags',value:(device.tags??[]).join(', '),maxLength:1055,enabled:!row.revoked,placeholder:'mac, residential',help:null,saveLabel:'Save tags'},protectedPaths:{label:'Protected paths',value:(device.protectedPaths??[]).join('\n'),maxLength:20500,enabled:!row.revoked,placeholder:'One absolute folder per line',help:'Worktree threads cannot write or run git here. Up to 20 folders.',saveLabel:'Save protected paths'},
   presence:{tone:available?(row.status==='stale'?'checking':'ready'):'missing',label:row.revoked?'Removed':here?'This device · Online':row.status==='online'?'Online':row.status==='stale'?'Last seen recently':device.lastHeartbeatAt?'Offline since':'Offline',at:!row.revoked&&!here&&row.status==='offline'&&device.lastHeartbeatAt?device.lastHeartbeatAt:null},runningLine:`${running} running conversation${running===1?'':'s'}`,
   sessions:(row.heartbeat?.externalSessions??[]).map(session=>({runtimeLabel:runtimes[session.runtime],folder:session.cwd.split(/[\\/]/u).filter(Boolean).at(-1)??'',lastActivityAt:session.lastActivityAt,minutesAgo:Math.max(0,Math.floor((now-Date.parse(session.lastActivityAt))/60000))})),readiness,
   factsLine:facts?`${facts.cores} cores · Load ${Number(facts.load5.toFixed(1))} · ${gb(facts.freeMemoryBytes)} memory free · ${gb(facts.freeDiskBytes)} disk free`:null,workLine:facts?`${facts.runningThreads.length} threads · ${facts.runningJobRuns.length} job runs`:null,lastCleanup:row.heartbeat?.lastCleanup??null};
 })});
}
function findRow(raw:unknown,id:string){const view=DeviceManagementViewSchema.parse(raw),row=view.devices.find(row=>row.deviceId===IdSchema.parse(id));if(!row)throw Error('The selected device is no longer available.');return row;}
export function deviceTagsAction(raw:unknown,id:string,value:string){const row=findRow(raw,id);if(!row.tags.enabled)throw Error('This device was removed.');return tagsAction.parse({schema:'device-action-v1',operation:'tags',input:{schema:'device-tags-input-v1',deviceId:row.deviceId,tags:[...new Set(value.split(/[\s,]+/u).filter(Boolean))]}});}
export function devicePathsAction(raw:unknown,id:string,value:string){const row=findRow(raw,id);if(!row.protectedPaths.enabled)throw Error('This device was removed.');return pathsAction.parse({schema:'device-action-v1',operation:'paths',input:{schema:'device-settings-input-v1',deviceId:row.deviceId,protectedPaths:[...new Set(value.split('\n').map(path=>path.trim()).filter(Boolean))]}});}
export const DeviceWorktreeViewSchema=z.strictObject({schema:z.literal('device-worktree-view-v1'),deviceId:IdSchema,name:text,available:z.boolean(),disk:WorktreeDiskSchema,usageLine:text,orphanCount:count,orphanBytes:count,orphans:WorktreeDiskSchema.shape.entries,orphanRows:z.array(z.strictObject({key:text,label:text})),showRemove:z.boolean(),removeEnabled:z.boolean(),confirmation:text,title:text,confirmLabel:text,cancelLabel:text});
export function deviceWorktreeView(raw:unknown,id:string,rawDisk:unknown){const row=findRow(raw,id),disk=WorktreeDiskSchema.parse(rawDisk);if(disk.deviceId!==row.deviceId)throw Error('The worktree view belongs to another device.');const orphans=disk.entries.filter(entry=>entry.orphan),orphanBytes=orphans.reduce((total,entry)=>total+entry.bytes,0);return DeviceWorktreeViewSchema.parse({schema:'device-worktree-view-v1',deviceId:row.deviceId,name:row.name,available:row.available,disk,usageLine:`Thread worktrees: ${gb(disk.threadBytes)} · Job and verification worktrees: ${gb(disk.jobBytes)}`,orphanCount:orphans.length,orphanBytes,orphans,orphanRows:orphans.map(entry=>({key:`${entry.kind}:${entry.id}`,label:`${entry.kind} · ${entry.id} · ${gb(entry.bytes)}`})),showRemove:orphans.length>0,removeEnabled:row.available,title:'Remove orphaned worktrees',confirmLabel:'Remove worktrees',cancelLabel:'Cancel',confirmation:`Remove ${orphans.length} worktree${orphans.length===1?'':'s'} on ${row.name}, using ${gb(orphanBytes)}? Each is older than seven days and has no retained work or process receipt.`});}
export function deviceOrphanAction(raw:unknown){const view=DeviceWorktreeViewSchema.parse(raw);if(!view.available)throw Error('This device is offline.');return orphanAction.parse({schema:'device-action-v1',operation:'orphans',input:{deviceId:view.deviceId,selection:{schema:'worktree-cleanup-input-v1',confirmed:true,entries:view.orphans.map(({projectId,id,kind,fingerprint})=>({projectId,id,kind,fingerprint}))}}});}
export function deviceCleanupRead(previous:unknown,next:unknown){const fresh=CleanupStateSchema.parse(next);if(previous==null)return fresh;const current=CleanupStateSchema.parse(previous);if(current.deviceId!==fresh.deviceId)throw Error('The cleanup receipt belongs to another device.');return current.lastRun&&(!fresh.lastRun||current.lastRun.endedAt>fresh.lastRun.endedAt)?current:fresh;}
export const DeviceCleanupViewSchema=z.strictObject({schema:z.literal('device-cleanup-view-v1'),deviceId:IdSchema,name:text,canClean:z.boolean(),path:text,emptyLine:text,state:CleanupStateSchema.nullable(),lastRun:z.strictObject({endedAt:text,freed:text,lineBeforeTime:text,summary:text,reason:text.nullable()}).nullable()});
export function deviceCleanupView(raw:unknown,id:string,rawState:unknown){const row=findRow(raw,id),state=rawState==null?null:CleanupStateSchema.parse(rawState);if(state&&state.deviceId!==row.deviceId)throw Error('The cleanup receipt belongs to another device.');const last=state?.lastRun??row.lastCleanup;return DeviceCleanupViewSchema.parse({schema:'device-cleanup-view-v1',deviceId:row.deviceId,name:row.name,canClean:row.canClean,state,path:`/api/devices/${row.deviceId}/cleanup`,emptyLine:row.canClean?'Cleanup has not run on this device.':'This device is offline.',lastRun:last?{endedAt:last.endedAt,freed:cleanupSize(last.freedBytes),lineBeforeTime:`Last run: freed ${cleanupSize(last.freedBytes)} on ${row.name} at`,summary:`${last.removed} removed · ${last.protected} protected · ${cleanupSize(last.freeBytes)} free`,reason:last.reason??null}:null});}
export const DeviceInvitationViewSchema=JoinInvitationSchema.extend({schema:z.literal('device-invitation-view-v1'),command:text,commandPrefix:text,title:text,help:text,codeLabel:text,expiresLabel:text});
export function deviceInvitationView(raw:unknown,hubUrl:string){const invite=JoinInvitationSchema.parse(raw),origin=DeviceOriginSchema.parse(hubUrl);return DeviceInvitationViewSchema.parse({...invite,schema:'device-invitation-view-v1',commandPrefix:`npx github:gongiskhan/jevellan join ${origin} `,title:'Add a device',help:'Run this command on the device you want to add.',codeLabel:'Join code',expiresLabel:'Expires',command:`npx github:gongiskhan/jevellan join ${origin} ${invite.code}`});}
/** Browser transport uses the same canonical body as the owner handler; no arbitrary URL or command is accepted. */
export function deviceActionHttp(raw:unknown){const action=DeviceActionSchema.parse(raw);return {path:'/api/devices/actions',method:'POST' as const,body:action};}

export const DeviceActionReceiptSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('device-action-receipt-v1'),operation:z.literal('tags'),deviceId:IdSchema,result:DeviceRosterSchema.shape.devices.element}),
 z.strictObject({schema:z.literal('device-action-receipt-v1'),operation:z.literal('paths'),deviceId:IdSchema,result:DeviceRosterSchema.shape.devices.element}),
 z.strictObject({schema:z.literal('device-action-receipt-v1'),operation:z.literal('clean'),deviceId:IdSchema,result:CleanupStateSchema}),
 z.strictObject({schema:z.literal('device-action-receipt-v1'),operation:z.literal('orphans'),deviceId:IdSchema,result:WorktreeDiskSchema}),
 z.strictObject({schema:z.literal('device-action-receipt-v1'),operation:z.literal('invite'),result:DeviceInvitationViewSchema})]).refine(value=>value.operation==='invite'||(value.operation==='tags'||value.operation==='paths'?value.result.device.id===value.deviceId:value.result.deviceId===value.deviceId),'The device action receipt belongs to another device.');
export function deviceMaintenanceAction(raw:unknown):boolean{const parsed=DeviceActionSchema.safeParse(raw);return parsed.success&&(parsed.data.operation==='clean'||parsed.data.operation==='orphans');}

export function deviceCleanAction(raw:unknown,id:string){const row=findRow(raw,id);if(!row.canClean)throw Error('This device is offline.');return cleanAction.parse({schema:'device-action-v1',operation:'clean',input:{deviceId:row.deviceId}});}

/** The transfer credential stays transient in the caller; validate its device before any browser navigation. */
export function deviceSwitchReply(raw:unknown,targetDeviceId:string){const reply=DeviceSwitchSchema.parse(raw);if(reply.targetDeviceId!==IdSchema.parse(targetDeviceId))throw Error('The selected device changed. Try again.');return reply;}

/** Posted controls never confer availability: the controller supplies a fresh canonical view. */
export function prepareDeviceAction(rawView:unknown,rawAction:unknown){
 const view=DeviceManagementViewSchema.parse(rawView),action=DeviceActionSchema.parse(rawAction);if(action.operation==='invite')return action;
 const row=findRow(view,action.input.deviceId),allowed=action.operation==='tags'?row.tags.enabled:action.operation==='paths'?row.protectedPaths.enabled:action.operation==='clean'?row.canClean:row.available;
 if(!allowed)throw Object.assign(new Error(row.revoked?'This device was removed.':'This device is offline.'),{status:409});return action;
}
export function deviceActionResult(rawAction:unknown,rawReceipt:unknown){
 const action=DeviceActionSchema.parse(rawAction),receipt=DeviceActionReceiptSchema.parse(rawReceipt);
 if(receipt.operation!==action.operation||(action.operation!=='invite'&&('deviceId' in receipt?receipt.deviceId!==action.input.deviceId:true)))throw Error('The device action reply did not match the request.');
 return receipt.result;
}
