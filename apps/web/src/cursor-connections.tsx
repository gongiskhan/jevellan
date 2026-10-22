import { useEffect, useState } from 'react';
import { CursorHookSetupSchema, NativeConversationPolicySchema, NativeConnectionsEditorSchema, NativeConnectionsSavedSchema,
  nativeConversationPolicy, nativeConnectionAddCommand, nativeConnectionFieldsView, type NativeConnectionFields, type NativeConnectionsEditor } from '@jevellan/core/client';
import { api } from './api.js';
import { useTask, type PageProps } from './components.js';

type Draft = { context: NativeConnectionsEditor['context']; fields: NativeConnectionFields };
export function CursorConnections({ props }: { props: PageProps }) {
  const [policy, setPolicy] = useState(nativeConversationPolicy);
  const [editor, setEditor] = useState<NativeConnectionsEditor>();
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState(false); const [configuration, setConfiguration] = useState('');
  const task = useTask(props.onError);
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/cursor/policy', NativeConversationPolicySchema, 'GET', undefined, { signal: controller.signal }).then(setPolicy).catch(props.onError);
    void api('/api/cursor/connections/editor', NativeConnectionsEditorSchema, 'GET', undefined, { signal: controller.signal })
      .then(value => { setEditor(value); setDraft(current => current ?? { context: value.context, fields: value.fields }); }).catch(props.onError);
    return () => controller.abort();
  }, [props.onError]);
  const hooks = (deviceId: string) => task.run(async () => {
    const value = await api(`/api/cursor/hooks?deviceId=${encodeURIComponent(deviceId)}`, CursorHookSetupSchema);
    setConfiguration(value.configuration);
  });
  const change = (key: keyof NativeConnectionFields, value: string) => setDraft(current => current ? { ...current, fields: { ...current.fields, [key]: value } } : current);
  const fields = draft?.fields, fieldView = fields ? nativeConnectionFieldsView(fields) : undefined;
  return <section className="card cursor-connections">
    <h2>Native conversations</h2>
    <p>{policy.description}</p>
    <p className="muted small-text">CSG uses the SSH connection already carried by your VS Code dev tunnel. Jevellan does not open another tunnel or a listening port there.</p>
    {editor?.rows.map(row => <div className="actions" key={row.connection.id}>
      <strong>{row.connection.name}</strong><span className="muted small-text">{row.summary.text} </span>
      <button className="secondary" disabled={task.busy} onClick={() => void hooks(row.connection.id)}>Review Cursor hooks</button>
      <button className="text-button" disabled={task.busy} onClick={() => void task.run(async () => {
        const value = await api('/api/cursor/connections/command', NativeConnectionsSavedSchema, 'POST', row.remove);
        setEditor(value.editor);
      })}>Disconnect</button>
    </div>)}
    <div className="actions"><button className="secondary" disabled={!draft} onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Add existing SSH connection'}</button>
      <button className="secondary" disabled={task.busy} onClick={() => void hooks(props.data.devices.currentDeviceId)}>Review hooks for this device</button></div>
    {editing && draft && fields && editor && fieldView && <form className="cursor-connection-form" onSubmit={event => { event.preventDefault(); void task.run(async () => {
      const value = await api('/api/cursor/connections/command', NativeConnectionsSavedSchema, 'POST', nativeConnectionAddCommand(draft.context, fields));
      setEditor(value.editor); setDraft({ context: value.editor.context, fields }); setEditing(false);
    }); }}>
      <label>Device name<input required value={fields.name} onChange={event => change('name', event.target.value)} /></label>
      <label>Remote user<input required value={fields.user} onChange={event => change('user', event.target.value)} autoComplete="off" /></label>
      <label>SSH host (optional)<input placeholder="127.0.0.1 for an existing dev tunnel" value={fields.host} onChange={event => change('host', event.target.value)} /></label>
      <label>Existing SSH port<input type="number" required min={editor.port.min} max={editor.port.max} value={fields.port} onChange={event => change('port', event.target.value)} /></label>
      <label>Gateway hosting the tunnel (optional)<input placeholder="Leave empty when the tunnel connects here" value={fields.gatewayHost} onChange={event => change('gatewayHost', event.target.value)} /></label>
      {fieldView.gatewayVisible && <label>Gateway user<input required value={fields.gatewayUser} onChange={event => change('gatewayUser', event.target.value)} /></label>}
      <label>SSH identity file (optional)<input placeholder={fieldView.identityPlaceholder} value={fields.identityFile} onChange={event => change('identityFile', event.target.value)} /></label>
      <label>Installed session reader on the remote device<input required placeholder="/…/cursor/bridge/…/cursor-stdio.mjs" value={fields.helperPath} onChange={event => change('helperPath', event.target.value)} /></label>
      <label>Node executable on the remote device<input required value={fields.nodePath} onChange={event => change('nodePath', event.target.value)} /></label>
      <label>Jevellan data folder on the remote device<input required placeholder="/home/…/.jevellan" value={fields.home} onChange={event => change('home', event.target.value)} /></label>
      <button disabled={task.busy}>Save connection</button>
    </form>}
    {configuration && <details open><summary>Cursor hooks for message delivery</summary>
      <p className="muted small-text">{policy.hookDescription}</p>
      <pre><code>{configuration}</code></pre>
      <p className="muted small-text">This view does not change Cursor settings. After hooks are enabled, send a message in Cursor to connect that session.</p>
    </details>}
  </section>;
}
