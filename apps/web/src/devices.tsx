import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { DeviceSwitchSchema, JoinInvitationSchema, type DeviceView } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { Modal, SectionHeading, dateTime, useTask, type PageProps } from './components.js';
import { Icon } from './icons.js';
import { CursorConnections } from './cursor-connections.js';

export function deviceAvailable(row: DeviceView, currentDeviceId: string) {
  return !row.revoked && (row.device.id === currentDeviceId || row.status !== 'offline');
}
function DeviceActivity({ row, currentDeviceId }: { row: DeviceView; currentDeviceId: string }) {
  const here = row.device.id === currentDeviceId;
  const online = deviceAvailable(row, currentDeviceId);
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
      <span>{row.heartbeat?.runningConversations.length ?? 0} running conversations</span>
      {row.heartbeat?.externalSessions.map((session, index) => (
        <span key={index}>
          {{ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' }[session.runtime]}{' '}
          active in {session.cwd.split(/[\\/]/).filter(Boolean).at(-1)} ·{' '}
          {new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
            -Math.max(0, Math.floor((Date.now() - Date.parse(session.lastActivityAt)) / 60_000)),
            'minute',
          )}
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
