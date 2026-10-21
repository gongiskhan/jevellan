import { useEffect, useRef, useState } from 'react';
import { EkoaEditorSchema, ekoaCallbackInput, ekoaUrlRequired, type EkoaEditor } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { SectionHeading, useSettingsSave, useTask, type PageProps } from './components.js';
import { clientId } from './client-id.js';
export function EkoaPage({ onError, message }: PageProps) {
  const [model, setModel] = useState<EkoaEditor>(), [url, setUrl] = useState(''), [enabled, setEnabled] = useState(false), [token, setToken] = useState('');
  const task = useTask(onError), save = useSettingsSave(), [connectId] = useState(clientId);
  const callback = useRef(window.location.pathname === '/settings/ekoa/callback' ? window.location.search : null);
  useEffect(() => {
    const abort = new AbortController(), query = callback.current;
    if (query !== null) window.history.replaceState({}, '', '/settings/ekoa');
    const read = async () => query !== null
      ? api('/hub/ekoa/editor/callback', EkoaEditorSchema, 'POST', ekoaCallbackInput(query), { signal: abort.signal, waitForHub: true })
      : api('/hub/ekoa/editor', EkoaEditorSchema, 'GET', undefined, { signal: abort.signal, waitForHub: true });
    void read().then(next => { setModel(next); setUrl(next.fields.url); setEnabled(next.fields.enabled); }).catch(error => { if (!abort.signal.aborted) onError(error); });
    return () => abort.abort();
  }, [onError]);
  if (!model) return null;
  return <div className="settings-page"><SectionHeading title={model.title} />
    <section className="card"><h2>{model.heading}</h2><p>{model.intro}</p>
      <div className="actions"><button type="button" disabled={task.busy} onClick={() => void task.run(async signal => {
        const next = await api('/hub/ekoa/editor/connect', EkoaEditorSchema, 'POST', { schema: 'ekoa-editor-connect-v1', clientRequestId: connectId, url }, { signal, waitForHub: true });
        setModel(next); if (next.connect.authorizationUrl) window.location.assign(next.connect.authorizationUrl); else onError(new Error(next.connect.failure));
      })}>{model.connectLabel}</button></div>
      <p className="muted">{model.presentation.oauthLine}</p>
      {model.state.oauth?.reason && <p role="alert">{model.state.oauth.reason}</p>}
      <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
        try { const next = await save(model.write.path, EkoaEditorSchema, model.write.method, { ...model.write.body, fields: { url, enabled }, operation: 'save', ...(token ? { credential: token } : {}) }, signal); setModel(next); message(next.savedNotice); }
        finally { setToken(''); }
      }); }}>
        <label>MCP URL<input disabled={task.busy} type="url" required={ekoaUrlRequired({ enabled })} placeholder={model.connect.defaultUrl} value={url} onChange={event => setUrl(event.target.value)} /></label>
        <label>Ekoa token<input disabled={task.busy} type="password" autoComplete="off" spellCheck={false} value={token} placeholder={model.presentation.tokenPlaceholder} onChange={event => setToken(event.target.value)} /></label>
        <p className="muted">{model.presentation.tokenLine} {model.tokenHelp}</p>
        <label className="check"><input disabled={task.busy} type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{model.mirrorLabel}</label>
        <div className="actions"><button disabled={task.busy}>Save</button><button type="button" className="secondary" disabled={task.busy} onClick={() => void task.run(async signal => setModel(await api('/hub/ekoa/editor/test', EkoaEditorSchema, 'POST', empty, { signal, waitForHub: true })))}>Test connection</button>
          {model.state.tokenSaved && <button type="button" className="secondary" disabled={task.busy} onClick={() => void task.run(async signal => {
            const next = await save(model.write.path, EkoaEditorSchema, model.write.method, { ...model.write.body, fields: { url, enabled }, operation: 'remove-token' }, signal); setModel(next); setEnabled(next.fields.enabled);
          })}>Remove token</button>}
        </div>
      </form>
    </section>
    {model.presentation.connection && <section className="card" aria-label="Ekoa connection"><h2>{model.presentation.connection.title}</h2>{model.presentation.connection.reason && <p>{model.presentation.connection.reason}</p>}
      {!!model.presentation.connection.tools.length && <details><summary>Available tools</summary><ul>{model.presentation.connection.tools.map(name => <li key={name}>{name}</li>)}</ul></details>}
    </section>}
    {!!model.presentation.mirrors.length && <section className="card"><h2>Mirrored tasks</h2><p>{model.presentation.mirrorsLine}</p>
      {model.presentation.mirrors.map(row => <p key={row.id}><strong>{row.title}</strong> · {row.state}</p>)}
      {model.presentation.errors.map(row => <p className="notice" key={row.id}>{row.message} {row.retryLine}</p>)}
    </section>}
  </div>;
}
