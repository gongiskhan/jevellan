import { useEffect, useState } from 'react';
import { CleanupSettingsEditorSchema, ConfigRevisionSchema, CleanupStateSchema, type CleanupSettingsEditor, type CleanupEditorFields, type CleanupState } from '@jevellan/core/client';
import { deviceManagementData } from './devices.js';
import {DeviceActionReceiptSchema,deviceActionResult,deviceCleanupView,deviceCleanupRead,deviceCleanAction,deviceActionHttp,type DeviceManagementView,type DeviceManagementRow} from '@jevellan/core/client';
import { api } from './api.js';
import { SectionHeading, dateTime, useSettingsSave, useTask, type PageProps } from './components.js';
function DeviceCleanup({row,management,props}:{row:DeviceManagementRow;management:DeviceManagementView;props:PageProps}) {
 const [state,setState]=useState<CleanupState>(),task=useTask(props.onError),view=deviceCleanupView(management,row.deviceId,state);
 useEffect(()=>{if(view.canClean)void api(view.path,CleanupStateSchema).then(next=>setState(current=>deviceCleanupRead(current,next))).catch(props.onError);},[view.canClean,view.path,props.onError]);
 return <section className="card"><h2>{view.name}</h2>{view.lastRun?<><p>{view.lastRun.lineBeforeTime} {dateTime(view.lastRun.endedAt)}</p>{view.lastRun.reason&&<p className="muted">{view.lastRun.reason}</p>}<p className="muted small-text">{view.lastRun.summary}</p></>:<p className="muted">{view.emptyLine}</p>}<button className="secondary" disabled={task.busy||!view.canClean} onClick={()=>void task.run(async signal=>{const request=deviceActionHttp(deviceCleanAction(management,row.deviceId));setState(CleanupStateSchema.parse(deviceActionResult(request.body,await api(request.path,DeviceActionReceiptSchema,request.method,request.body,{signal}))));})}>Clean now</button></section>;
}
export function CleanupPage(props: PageProps) {
  const devices=deviceManagementData(props.data);
  const [model, setModel] = useState<CleanupSettingsEditor>(), [draft, setDraft] = useState<CleanupEditorFields>(), task = useTask(props.onError), save = useSettingsSave();
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/config/cleanup', CleanupSettingsEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(next => { setModel(next); setDraft(next.fields); }).catch(error => { if (!controller.signal.aborted) props.onError(error); });
    return () => controller.abort();
  }, [props.onError]);
  if (!model || !draft) return null;
  return <><SectionHeading title={model.title} /><p className="intro">{model.intro}</p>
    <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
      await save(model.write.path, ConfigRevisionSchema, model.write.method, { ...model.write.body, fields: draft }, signal);
      await props.reload(signal); props.message(model.savedNotice);
    }); }}>
      {model.categories.map(row => <section className="card" key={row.id}><h2>{row.label}</h2><div className="form-grid">
        <label>Keep for (days)<input aria-label={`${row.label}: Keep for (days)`} type="number" {...model.days} required value={draft[row.id].days} onChange={event => setDraft({ ...draft, [row.id]: { ...draft[row.id], days: event.target.value } })} /></label>
        <label>At most (GB)<input aria-label={`${row.label}: At most (GB)`} type="number" {...model.maxGb} required value={draft[row.id].maxGb} onChange={event => setDraft({ ...draft, [row.id]: { ...draft[row.id], maxGb: event.target.value } })} /></label>
      </div></section>)}
      <section className="card"><h2>{model.floorTitle}</h2><label>{model.floorLabel}<input type="number" {...model.floor} required value={draft.freeDiskFloorGb} onChange={event => setDraft({ ...draft, freeDiskFloorGb: event.target.value })} /></label><p className="muted">{model.floorHelp}</p></section>
      <div className="actions"><button disabled={task.busy} type="submit">{model.saveLabel}</button></div>
    </form>
    {devices.cleanupDeviceIds.map(id=><DeviceCleanup row={devices.devices.find(row=>row.deviceId===id)!} management={devices} props={props} key={id}/>)}
  </>;
}
