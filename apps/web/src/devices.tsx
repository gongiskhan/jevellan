import {useEffect,useRef,useState} from 'react';
import {DeviceActionReceiptSchema,deviceActionResult,DeviceSwitchSchema,deviceSwitchReply,DeviceInvitationViewSchema,WorktreeDiskSchema,deviceManagementView,deviceTagsAction,devicePathsAction,deviceActionHttp,deviceWorktreeView,deviceOrphanAction,type WorktreeDisk,type DeviceView,type DeviceManagementRow,type DeviceManagementView} from '@jevellan/core/client';
export {deviceAvailable} from '@jevellan/core/client';
import {api,empty,type SettingsData} from './api.js';
import {Modal,SectionHeading,dateTime,useTask,type PageProps} from './components.js';
import {Icon} from './icons.js';
import {CursorConnections} from './cursor-connections.js';
import {OpenTerminalButton,TerminalLauncher} from './terminal.js';
/** Old workspace replies have no optional view; use the same shared engine projection for that compatibility boundary. */
export function deviceManagementData(data:SettingsData){return data.deviceManagement??deviceManagementView({schema:'device-management-facts-v1',roster:data.roster,now:Date.now()});}
function DeviceControls({source,row,management,props}:{source:DeviceView;row:DeviceManagementRow;management:DeviceManagementView;props:PageProps}){
 const task=useTask(props.onError),[tags,setTags]=useState(row.tags.value),[protectedPaths,setProtectedPaths]=useState(row.protectedPaths.value);
 const[disk,setDisk]=useState<WorktreeDisk>(),[error,setError]=useState(''),[confirm,setConfirm]=useState<ReturnType<typeof deviceWorktreeView>>(),[terminalsShown,setTerminalsShown]=useState(false);
 useEffect(()=>setTags(row.tags.value),[source.device.tags]);
 useEffect(()=>setProtectedPaths(row.protectedPaths.value),[row.protectedPaths.value]);
 useEffect(()=>{if(!row.available)return;const controller=new AbortController();void api(row.worktrees.path,WorktreeDiskSchema,'GET',undefined,{signal:controller.signal}).then(setDisk).catch(()=>{if(!controller.signal.aborted)setError(row.worktrees.unavailableNotice);});return()=>controller.abort();},[row.worktrees.path,row.available,row.worktrees.unavailableNotice]);
 const worktrees=disk?deviceWorktreeView(management,row.deviceId,disk):null;
 return <>
  {row.appsOnly&&<p className="chip">Apps only</p>}
  {row.available&&<OpenTerminalButton props={props} deviceId={row.deviceId} cwd="home" label="Terminal"/>}
  {row.available&&<button className="text-button" aria-expanded={terminalsShown} onClick={()=>setTerminalsShown(!terminalsShown)}>Open terminals</button>}
  {terminalsShown&&<TerminalLauncher props={props} deviceId={row.deviceId}/>}
  {row.readiness.map((notice,index)=><p className="notice" key={index}>{notice.beforeCommand}<code>{notice.command}</code>{notice.afterCommand}</p>)}
  {row.factsLine&&<p className="muted small-text">{row.factsLine}<br/>{row.workLine}</p>}
  <form onSubmit={event=>{event.preventDefault();void task.run(async signal=>{const request=deviceActionHttp(deviceTagsAction(management,row.deviceId,tags));deviceActionResult(request.body,await api(request.path,DeviceActionReceiptSchema,request.method,request.body,{signal,waitForHub:true}));await props.reload(signal);});}}>
   <label>{row.tags.label}<input value={tags} maxLength={row.tags.maxLength} onChange={event=>setTags(event.target.value)} placeholder={row.tags.placeholder} disabled={task.busy||!row.tags.enabled}/></label><button type="submit" className="secondary" disabled={task.busy||!row.tags.enabled}>{row.tags.saveLabel}</button>
  </form>
  <form onSubmit={event=>{event.preventDefault();void task.run(async signal=>{const request=deviceActionHttp(devicePathsAction(management,row.deviceId,protectedPaths));deviceActionResult(request.body,await api(request.path,DeviceActionReceiptSchema,request.method,request.body,{signal,waitForHub:true}));await props.reload(signal);});}}>
   <label>{row.protectedPaths.label}<textarea value={protectedPaths} maxLength={row.protectedPaths.maxLength} rows={3} disabled={task.busy||!row.protectedPaths.enabled} placeholder={row.protectedPaths.placeholder} onChange={event=>setProtectedPaths(event.target.value)}/></label><p className="muted small-text">{row.protectedPaths.help}</p><button className="secondary" disabled={task.busy||!row.protectedPaths.enabled}>{row.protectedPaths.saveLabel}</button>
  </form>
  {worktrees&&<p className="muted small-text">{worktrees.usageLine}</p>}{error&&<p className="muted small-text">{error}</p>}
  <button className="secondary" disabled={task.busy||!row.available} onClick={()=>void task.run(async signal=>{setDisk(await api(row.worktrees.path,WorktreeDiskSchema,'GET',undefined,{signal}));setError('');})}>{row.worktrees.inspectLabel}</button>
  {worktrees?.showRemove&&<button className="secondary" disabled={task.busy||!worktrees.removeEnabled} onClick={()=>setConfirm(worktrees)}>{row.worktrees.removeLabel}</button>}
  {confirm&&<Modal title={confirm.title} close={()=>setConfirm(undefined)}><p>{confirm.confirmation}</p><ul>{confirm.orphanRows.map(entry=><li key={entry.key}>{entry.label}</li>)}</ul><div className="form-actions"><button className="secondary" onClick={()=>setConfirm(undefined)}>{confirm.cancelLabel}</button><button disabled={task.busy} onClick={()=>void task.run(async signal=>{const request=deviceActionHttp(deviceOrphanAction(confirm));setDisk(WorktreeDiskSchema.parse(deviceActionResult(request.body,await api(request.path,DeviceActionReceiptSchema,request.method,request.body,{signal}))));setConfirm(undefined);})}>{confirm.confirmLabel}</button></div></Modal>}
 </>;
}
function DeviceActivity({row}:{row:DeviceManagementRow}){return <div className="device-activity"><span className={`status status-${row.presence.tone}`}><i/>{row.presence.label}{row.presence.at&&<> {dateTime(row.presence.at)}</>}</span><span>{row.runningLine}</span>{row.sessions.map((session,index)=><span key={index}>{session.runtimeLabel} active in {session.folder} · <span className="device-activity-time">{new Intl.RelativeTimeFormat(undefined,{numeric:'auto'}).format(-session.minutesAgo,'minute')}</span></span>)}</div>;}
async function switchDevice(targetDeviceId:string,signal:AbortSignal){
 const result=deviceSwitchReply(await api('/api/devices/switch',DeviceSwitchSchema,'POST',{schema:'device-switch-input-v1',targetDeviceId,route:location.pathname+location.search+location.hash},{signal,waitForHub:true}),targetDeviceId);
 signal.throwIfAborted();const url=new URL('/switch',result.targetUrl);url.searchParams.set('token',result.token);location.assign(url.href);
}
export function DeviceSwitcher({props}:{props:PageProps}){
 const view=deviceManagementData(props.data),task=useTask(props.onError),menu=useRef<HTMLDetailsElement>(null),current=view.devices.find(row=>row.current);
 useEffect(()=>{const outside=(event:PointerEvent)=>{if(menu.current?.open&&!menu.current.contains(event.target as Node))menu.current.open=false;};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[]);
 return <details className="device-switcher" ref={menu}><summary title={current?.name}><i className="state-dot" aria-hidden="true"/><span className="device-switcher-name">{current?.name}</span><Icon name="chevron" size={12}/></summary><div>{view.devices.map(row=><button key={row.deviceId} className={row.current?'current':''} disabled={task.busy||!row.canSwitch} onClick={()=>void task.run(signal=>switchDevice(row.deviceId,signal))}><i className={`state-dot ${row.available?'state-done':'state-cancelled'}`} aria-hidden="true"/><strong>{row.name}</strong><DeviceActivity row={row}/></button>)}</div></details>;
}
export function DevicesPage(props:PageProps){
 const view=deviceManagementData(props.data),task=useTask(props.onError),[invitation,setInvitation]=useState<ReturnType<typeof DeviceInvitationViewSchema.parse>>();
 return <><SectionHeading title="Devices"><button disabled={task.busy} onClick={()=>void task.run(async signal=>{setInvitation(await api('/api/devices/invitations/view',DeviceInvitationViewSchema,'POST',empty,{signal,waitForHub:true}));})}>Add a device</button></SectionHeading><p className="intro">Every device runs its own conversations. Open one to work from it without signing in again.</p><div className="project-list">{view.devices.map(row=><section className="card device-card" key={row.deviceId}><div className="card-heading"><h2>{row.name}</h2><span className="chip">{row.roleLabel}</span></div><p className="muted">{row.osLabel} · {row.versionLine}</p><DeviceActivity row={row}/><DeviceControls props={props} row={row} source={props.data.roster.devices.find(source=>source.device.id===row.deviceId)!} management={view}/><button className="secondary" disabled={task.busy||!row.canSwitch} onClick={()=>void task.run(signal=>switchDevice(row.deviceId,signal))}>Open</button></section>)}</div><CursorConnections props={props}/><section className="card device-auto"><label className="toggle"><input type="checkbox" disabled/>Automatic device choice</label><p className="muted small-text">Coming later.</p></section>{invitation&&<Modal title={invitation.title} close={()=>setInvitation(undefined)}><p>{invitation.help}</p><div className="verification-code"><span>{invitation.codeLabel}</span><strong>{invitation.code}</strong></div><pre className="join-command">{invitation.commandPrefix}<span>{invitation.code}</span></pre><p className="muted">{invitation.expiresLabel} {dateTime(invitation.expiresAt)}.</p></Modal>}</>;
}
