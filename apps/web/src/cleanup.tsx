import { useEffect, useState } from 'react';
import { CleanupSettingsSchema, CleanupStateSchema, type CleanupCategory, type CleanupState, type DeviceView } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { SectionHeading, dateTime, useTask, type PageProps } from './components.js';
const labels = { logs: 'Job logs and daemon logs', evidence: 'Thread evidence and screenshots', worktrees: 'Worktrees of landed or resolved threads', workspaces: 'Job workspaces' } as const;
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
  const [draft, setDraft] = useState(props.data.config.configuration['x-jevellan'].cleanup), task = useTask(props.onError);
  const category = (key: CleanupCategory) => <section className="card" key={key}><h2>{labels[key]}</h2><div className="form-grid">
    <label>Keep for (days)<input aria-label={`${labels[key]}: Keep for (days)`} type="number" min={0} max={3650} step={1} required value={draft[key].days} onChange={event => setDraft({ ...draft, [key]: { ...draft[key], days: Number(event.target.value) } })} /></label>
    <label>At most (GB)<input aria-label={`${labels[key]}: At most (GB)`} type="number" min={0} max={10000} step="any" required value={draft[key].maxGb} onChange={event => setDraft({ ...draft, [key]: { ...draft[key], maxGb: Number(event.target.value) } })} /></label>
  </div></section>;
  return <><SectionHeading title="Cleanup" /><p className="intro">Each device checks hourly when it is idle. Oldest eligible items go first. Active work, unlanded worktrees, backups, memory, the vault, ledgers and the journal stay.</p>
    <form onSubmit={event => { event.preventDefault(); void task.run(async signal => { const cleanup = CleanupSettingsSchema.parse(draft), config = props.data.config.configuration; await props.saveConfig({ ...config, 'x-jevellan': { ...config['x-jevellan'], cleanup } }, signal); }); }}>
      {(['logs', 'evidence', 'worktrees', 'workspaces'] as const).map(category)}
      <section className="card"><h2>Free disk space</h2><label>Keep at least (GB) free<input type="number" min={0} max={100000} step="any" required value={draft.freeDiskFloorGb} onChange={event => setDraft({ ...draft, freeDiskFloorGb: Number(event.target.value) })} /></label><p className="muted">Below this floor, the oldest eligible items can go before their retention age.</p></section>
      <div className="actions"><button disabled={task.busy} type="submit">Save cleanup settings</button></div>
    </form>
    {props.data.roster.devices.filter(row => !row.revoked).map(row => <DeviceCleanup row={row} props={props} key={row.device.id} />)}
  </>;
}
