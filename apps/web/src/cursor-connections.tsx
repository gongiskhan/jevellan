import { useEffect, useState } from 'react';
import { CursorConnectionsSchema, CursorHookSetupSchema, type CursorConnection } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { useTask, type PageProps } from './components.js';

export function CursorConnections({ props }: { props: PageProps }) {
  const [connections, setConnections] = useState<CursorConnection[]>([]);
  const [editing, setEditing] = useState(false); const [configuration, setConfiguration] = useState('');
  const [name, setName] = useState('CSG'); const [user, setUser] = useState(''); const [port, setPort] = useState('');
  const [identity, setIdentity] = useState(''); const [helper, setHelper] = useState('');
  const [node, setNode] = useState('/usr/bin/node'); const [home, setHome] = useState('');
  const [gateway, setGateway] = useState(''); const [gatewayUser, setGatewayUser] = useState('');
  const task = useTask(props.onError);
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/cursor/connections', CursorConnectionsSchema, 'GET', undefined, { signal: controller.signal })
      .then(value => setConnections(value.connections)).catch(props.onError);
    return () => controller.abort();
  }, [props.onError]);
  const hooks = (deviceId: string) => task.run(async () => {
    const value = await api(`/api/cursor/hooks?deviceId=${encodeURIComponent(deviceId)}`, CursorHookSetupSchema);
    setConfiguration(value.configuration);
  });
  return <section className="card cursor-connections">
    <h2>Cursor conversations</h2>
    <p>Cursor desktop sessions from the last five days appear alongside your conversations, with formatted messages and live activity.</p>
    <p className="muted small-text">CSG uses the SSH connection already carried by your VS Code dev tunnel. Jevellan does not open another tunnel or a listening port there.</p>
    {connections.map(connection => <div className="actions" key={connection.id}>
      <strong>{connection.name}</strong><span className="muted small-text">Existing tunnel · {connection.gateway ? `${connection.gateway.host} · ` : ''}port {connection.port}</span>
      <button className="secondary" disabled={task.busy} onClick={() => void hooks(connection.id)}>Review Cursor hooks</button>
      <button className="text-button" disabled={task.busy} onClick={() => void task.run(async () => {
        const value = await api('/api/cursor/connections', CursorConnectionsSchema, 'POST', { schema: 'cursor-connections-v1', connections: connections.filter(row => row.id !== connection.id) });
        setConnections(value.connections);
      })}>Disconnect</button>
    </div>)}
    <div className="actions"><button className="secondary" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Add existing tunnel connection'}</button>
      <button className="secondary" disabled={task.busy} onClick={() => void hooks(props.data.devices.currentDeviceId)}>Review hooks for this device</button></div>
    {editing && <form className="cursor-connection-form" onSubmit={event => { event.preventDefault(); void task.run(async () => {
      const connection = { id: `cursor_remote_${clientId()}`, name, user, port: Number(port), nodePath: node, home, helperPath: helper, ...(identity.trim() ? { identityFile: identity.trim() } : {}), ...(gateway.trim() ? { gateway: { host: gateway.trim(), user: gatewayUser.trim() } } : {}) };
      const value = await api('/api/cursor/connections', CursorConnectionsSchema, 'POST', { schema: 'cursor-connections-v1', connections: [...connections, connection] });
      setConnections(value.connections); setEditing(false);
    }); }}>
      <label>Device name<input required value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Remote user<input required value={user} onChange={event => setUser(event.target.value)} autoComplete="off" /></label>
      <label>Existing tunnel SSH port<input type="number" required min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
      <label>Gateway hosting the tunnel (optional)<input placeholder="Leave empty when the tunnel connects here" value={gateway} onChange={event => setGateway(event.target.value)} /></label>
      {gateway.trim() && <label>Gateway user<input required value={gatewayUser} onChange={event => setGatewayUser(event.target.value)} /></label>}
      <label>SSH identity file (optional)<input placeholder={gateway.trim() ? 'Absolute path on the gateway' : 'Absolute path on this device'} value={identity} onChange={event => setIdentity(event.target.value)} /></label>
      <label>Installed Cursor helper on the remote device<input required placeholder="/…/cursor/bridge/…/cursor-stdio.mjs" value={helper} onChange={event => setHelper(event.target.value)} /></label>
      <label>Node executable on the remote device<input required value={node} onChange={event => setNode(event.target.value)} /></label>
      <label>Jevellan data folder on the remote device<input required placeholder="/home/…/.jevellan" value={home} onChange={event => setHome(event.target.value)} /></label>
      <button disabled={task.busy}>Save connection</button>
    </form>}
    {configuration && <details open><summary>Cursor hooks for message delivery</summary>
      <p className="muted small-text">This configuration connects existing desktop conversations. Steering arrives after a tool call; queued messages become new turns when Cursor finishes. A completed session stays available for follow-up messages for up to seven hours. Existing hooks must be preserved when enabling this connection.</p>
      <pre><code>{configuration}</code></pre>
      <p className="muted small-text">This view does not change Cursor settings. After hooks are enabled, send a message in Cursor to connect that session.</p>
    </details>}
  </section>;
}
