import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { DeviceSwitchSchema, DeviceViewSchema, JoinInvitationSchema, WorktreeDiskSchema, type WorktreeDisk, type DeviceView } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { Modal, SectionHeading, dateTime, useTask, type PageProps } from './components.js';
import { Icon } from './icons.js';
import { CursorConnections } from './cursor-connections.js';
import { OpenTerminalButton, TerminalLauncher } from './terminal.js';
const gb = (bytes: number) => `${Number((bytes / 1e9).toFixed(1))} GB`;
function DeviceControls({ row, props }: { row: DeviceView; props: PageProps }) {
  const task = useTask(props.onError), [tags, setTags] = useState((row.device.tags ?? []).join(', '));
  const [protectedPaths, setProtectedPaths] = useState((row.device.protectedPaths ?? []).join('\n'));
  const [disk, setDisk] = useState<WorktreeDisk>(), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
  const [terminalsShown, setTerminalsShown] = useState(false);
  const endpoint = `/api/devices/${row.device.id}/worktrees`;
  const available = deviceAvailable(row, props.data.roster.currentDeviceId);
  useEffect(() => setTags((row.device.tags ?? []).join(', ')), [row.device.tags]);
  const savedProtectedPaths = (row.device.protectedPaths ?? []).join('\n');
  useEffect(() => setProtectedPaths(savedProtectedPaths), [savedProtectedPaths]);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    api(endpoint, WorktreeDiskSchema, 'GET', undefined, { signal: controller.signal }).then(setDisk).catch(() => { if (!controller.signal.aborted) setError('Worktree usage is unavailable.'); });
    return () => controller.abort();
  }, [endpoint, available]);
  const orphans = disk?.entries.filter(entry => entry.orphan) ?? [], facts = row.heartbeat?.facts;
  return <>
    {row.device.workPolicy?.mode === 'apps-only' && <p className="chip">Apps only</p>}
    {available && <OpenTerminalButton props={props} deviceId={row.device.id} cwd="home" label="Terminal" />}
    {available && <button className="text-button" aria-expanded={terminalsShown} onClick={() => setTerminalsShown(!terminalsShown)}>Open terminals</button>}
    {terminalsShown && <TerminalLauncher props={props} deviceId={row.device.id} />}
    {row.device.role === 'hub' && facts?.power?.status === 'available' && facts.power.acSleepMinutes > 0 && <p className="notice">Hub readiness: this Mac can sleep on AC power after {facts.power.acSleepMinutes} minutes. Nightly work may stop. Run <code>sudo pmset -c sleep 0</code> on the hub, then check again.</p>}
    {row.device.role === 'hub' && facts?.power?.status === 'unavailable' && <p className="notice">Hub readiness: AC power settings could not be read. Check them with <code>pmset -g custom</code> on the hub.</p>}
    {facts && <p className="muted small-text">{facts.cores} cores · Load {Number(facts.load5.toFixed(1))} · {gb(facts.freeMemoryBytes)} memory free · {gb(facts.freeDiskBytes)} disk free<br />{facts.runningThreads.length} threads · {facts.runningJobRuns.length} job runs</p>}
    <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
      await api('/hub/devices/tags', DeviceViewSchema, 'POST', { schema: 'device-tags-input-v1', deviceId: row.device.id, tags: [...new Set(tags.split(/[\s,]+/u).filter(Boolean))] }, { signal, waitForHub: true });
      await props.reload(signal);
    }); }}>
      <label>Device tags<input value={tags} maxLength={1055} onChange={event => setTags(event.target.value)} placeholder="mac, residential" disabled={task.busy || row.revoked} /></label>
      <button type="submit" className="secondary" disabled={task.busy || row.revoked}>Save tags</button>
    </form>
    <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
      await api('/hub/devices/settings', DeviceViewSchema, 'POST', { schema: 'device-settings-input-v1', deviceId: row.device.id,
        protectedPaths: [...new Set(protectedPaths.split('\n').map(path => path.trim()).filter(Boolean))] }, { signal, waitForHub: true }); await props.reload(signal);
    }); }}>
      <label>Protected paths<textarea value={protectedPaths} maxLength={20500} rows={3} disabled={task.busy || row.revoked} placeholder="One absolute folder per line" onChange={event => setProtectedPaths(event.target.value)} /></label>
      <p className="muted small-text">Worktree threads cannot write or run git here. Up to 20 folders.</p><button className="secondary" disabled={task.busy || row.revoked}>Save protected paths</button>
    </form>
    {disk && <p className="muted small-text">Thread worktrees: {gb(disk.threadBytes)} · Job and verification worktrees: {gb(disk.jobBytes)}</p>}
    {error && <p className="muted small-text">{error}</p>}
    <button className="secondary" disabled={task.busy || !available} onClick={() => void task.run(async signal => {
      setDisk(await api(endpoint, WorktreeDiskSchema, 'GET', undefined, { signal })); setError('');
    })}>Inspect worktrees</button>
    {orphans.length > 0 && <button className="secondary" disabled={task.busy || !available} onClick={() => setConfirm(true)}>Remove orphaned worktrees</button>}
    {confirm && <Modal title="Remove orphaned worktrees" close={() => setConfirm(false)}>
      <p>Remove {orphans.length} worktree{orphans.length === 1 ? '' : 's'} on {row.device.name}, using {gb(orphans.reduce((n, row) => n + row.bytes, 0))}? Each is older than seven days and has no retained work or process receipt.</p>
      <ul>{orphans.map(entry => <li key={`${entry.kind}:${entry.id}`}>{entry.kind} · {entry.id} · {gb(entry.bytes)}</li>)}</ul>
      <div className="form-actions"><button className="secondary" onClick={() => setConfirm(false)}>Cancel</button><button disabled={task.busy} onClick={() => void task.run(async signal => {
        setDisk(await api(endpoint, WorktreeDiskSchema, 'POST', { schema: 'worktree-cleanup-input-v1', confirmed: true, entries: orphans.map(({ projectId, id, kind, fingerprint }) => ({ projectId, id, kind, fingerprint })) }, { signal })); setConfirm(false);
      })}>Remove worktrees</button></div>
    </Modal>}
  </>;
}

export function deviceAvailable(row: DeviceView, currentDeviceId: string) {
  return !row.revoked && (row.device.id === currentDeviceId || row.status !== 'offline');
}
function DeviceActivity({ row, currentDeviceId }: { row: DeviceView; currentDeviceId: string }) {
  const here = row.device.id === currentDeviceId;
  const online = deviceAvailable(row, currentDeviceId);
  const running = row.heartbeat?.runningConversations.length ?? 0;
  return (
    <div className="device-activity">
      <span
        className={`status status-${online ? (row.status === 'stale' ? 'checking' : 'ready') : 'missing'}`}
      >
        <i />
        {row.revoked
          ? 'Removed'
          : here
            ? 'This device · Online'
            : row.status === 'online'
              ? 'Online'
              : row.status === 'stale'
                ? 'Last seen recently'
                : row.device.lastHeartbeatAt
                  ? `Offline since ${dateTime(row.device.lastHeartbeatAt)}`
                  : 'Offline'}
      </span>
      <span>
        {running} running conversation{running === 1 ? '' : 's'}
      </span>
      {row.heartbeat?.externalSessions.map((session, index) => (
        <span key={index}>
          {{ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' }[session.runtime]}{' '}
          active in {session.cwd.split(/[\\/]/).filter(Boolean).at(-1)} ·{' '}
          <span className="device-activity-time">
            {new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
              -Math.max(0, Math.floor((Date.now() - Date.parse(session.lastActivityAt)) / 60_000)),
              'minute',
            )}
          </span>
        </span>
      ))}
    </div>
  );
}
async function switchDevice(targetDeviceId: string, signal: AbortSignal) {
  const result = await api(
    '/api/devices/switch',
    DeviceSwitchSchema,
    'POST',
    {
      schema: 'device-switch-input-v1',
      targetDeviceId,
      route: location.pathname + location.search + location.hash,
    },
    { signal, waitForHub: true },
  );
  if (result.targetDeviceId !== targetDeviceId) throw new Error('The selected device changed. Try again.');
  signal.throwIfAborted();
  const url = new URL('/switch', result.targetUrl);
  url.searchParams.set('token', result.token);
  location.assign(url.href);
}
export function DeviceSwitcher({ props }: { props: PageProps }) {
  const { roster } = props.data;
  const task = useTask(props.onError);
  const menu = useRef<HTMLDetailsElement>(null);
  const current = roster.devices.find((row) => row.device.id === roster.currentDeviceId);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <details className="device-switcher" ref={menu}>
      <summary title={current?.device.name}>
        <i className="state-dot" aria-hidden="true" />
        <span className="device-switcher-name">{current?.device.name}</span>
        <Icon name="chevron" size={12} />
      </summary>
      <div>
        {roster.devices.map((row) => (
          <button
            key={row.device.id}
            className={row.device.id === roster.currentDeviceId ? 'current' : ''}
            disabled={
              task.busy ||
              row.device.id === roster.currentDeviceId ||
              !deviceAvailable(row, roster.currentDeviceId)
            }
            onClick={() => void task.run((signal) => switchDevice(row.device.id, signal))}
          >
            <i
              className={`state-dot ${deviceAvailable(row, roster.currentDeviceId) ? 'state-done' : 'state-cancelled'}`}
              aria-hidden="true"
            />
            <strong>{row.device.name}</strong>
            <DeviceActivity row={row} currentDeviceId={roster.currentDeviceId} />
          </button>
        ))}
      </div>
    </details>
  );
}
export function DevicesPage(props: PageProps) {
  const { roster } = props.data;
  const task = useTask(props.onError);
  const [invitation, setInvitation] = useState<z.infer<typeof JoinInvitationSchema>>();
  const hub = roster.devices.find((row) => row.device.role === 'hub')?.device;
  return (
    <>
      <SectionHeading title="Devices">
        <button
          disabled={task.busy}
          onClick={() =>
            void task.run(async (signal) => {
              setInvitation(
                await api('/hub/devices/invitations', JoinInvitationSchema, 'POST', empty, {
                  signal,
                  waitForHub: true,
                }),
              );
            })
          }
        >
          Add a device
        </button>
      </SectionHeading>
      <p className="intro">
        Every device runs its own conversations. Open one to work from it without signing in again.
      </p>
      <div className="project-list">
        {roster.devices.map((row) => (
          <section className="card device-card" key={row.device.id}>
            <div className="card-heading">
              <h2>{row.device.name}</h2>
              <span className="chip">{row.device.role === 'hub' ? 'Hub' : 'Member'}</span>
            </div>
            <p className="muted">
              {row.device.os === 'darwin' ? 'macOS' : 'Linux'} · Version {row.device.version}
            </p>
            <DeviceActivity row={row} currentDeviceId={roster.currentDeviceId} />
            <DeviceControls row={row} props={props} />
            <button
              className="secondary"
              disabled={
                task.busy ||
                row.device.id === roster.currentDeviceId ||
                !deviceAvailable(row, roster.currentDeviceId)
              }
              onClick={() => void task.run((signal) => switchDevice(row.device.id, signal))}
            >
              Open
            </button>
          </section>
        ))}
      </div>
      <CursorConnections props={props} />
      <section className="card device-auto">
        <label className="toggle">
          <input type="checkbox" disabled />
          Automatic device choice
        </label>
        <p className="muted small-text">Coming later.</p>
      </section>
      {invitation && (
        <Modal title="Add a device" close={() => setInvitation(undefined)}>
          <p>Run this command on the device you want to add.</p>
          <div className="verification-code">
            <span>Join code</span>
            <strong>{invitation.code}</strong>
          </div>
          <pre className="join-command">
            npx github:gongiskhan/jevellan join {hub?.url} <span>{invitation.code}</span>
          </pre>
          <p className="muted">Expires {dateTime(invitation.expiresAt)}.</p>
        </Modal>
      )}
    </>
  );
}
