import { useEffect, useState } from 'react';
import { CleanupSettingsEditorSchema, ConfigRevisionSchema, CleanupStateSchema, type CleanupSettingsEditor, type CleanupEditorFields, type CleanupState, type DeviceView } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { SectionHeading, dateTime, useSettingsSave, useTask, type PageProps } from './components.js';
const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
function DeviceCleanup({ row, props }: { row: DeviceView; props: PageProps }) {
  const [state, setState] = useState<CleanupState>(), task = useTask(props.onError);
  const available = !row.revoked && (row.device.id === props.data.roster.currentDeviceId || row.status === 'online');
  const path = `/api/devices/${row.device.id}/cleanup`;
  useEffect(() => { if (available) void api(path, CleanupStateSchema).then(next => setState(current => current?.lastRun && (!next.lastRun || current.lastRun.endedAt > next.lastRun.endedAt) ? current : next)).catch(props.onError); }, [available, path, props.onError]);
  const last = state?.lastRun ?? row.heartbeat?.lastCleanup;
  return <section className="card"><h2>{row.device.name}</h2>
    {last ? <><p>Last run: freed {size(last.freedBytes)} on {row.device.name} at {dateTime(last.endedAt)}</p>
      {last.reason && <p className="muted">{last.reason}</p>}
      <p className="muted small-text">{last.removed} removed · {last.protected} protected · {size(last.freeBytes)} free</p></> : <p className="muted">{available ? 'Cleanup has not run on this device.' : 'This device is offline.'}</p>}
    <button className="secondary" disabled={task.busy || !available} onClick={() => void task.run(async signal => setState(await api(path, CleanupStateSchema, 'POST', empty, { signal })))}>Clean now</button>
  </section>;
}
export function CleanupPage(props: PageProps) {
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
    {props.data.roster.devices.filter(row => !row.revoked).map(row => <DeviceCleanup row={row} props={props} key={row.device.id} />)}
  </>;
}
