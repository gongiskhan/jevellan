import { useEffect, useState } from 'react';
import { EkoaStateSchema } from '@jevellan/core/client';
import type { z } from 'zod';
import { api, empty } from './api.js';
import { SectionHeading, useSettingsSave, useTask, type PageProps } from './components.js';
export function EkoaPage({ onError, message }: PageProps) {
  const [state, setState] = useState<z.infer<typeof EkoaStateSchema>>(); const [url, setUrl] = useState(''); const [enabled, setEnabled] = useState(false); const [token, setToken] = useState('');
  const task = useTask(onError); const save = useSettingsSave();
  useEffect(() => {
    const abort = new AbortController();
    api('/hub/ekoa', EkoaStateSchema, 'GET', undefined, { signal: abort.signal, waitForHub: true }).then(next => { setState(next); setUrl(next.settings.url); setEnabled(next.settings.enabled); }, onError);
    return () => abort.abort();
  }, [onError]);
  return <div className="settings-page"><SectionHeading title="Ekoa" />
    <section className="card"><h2>Tasks that need you</h2><p>Decisions, reviewed pull requests and proposed tasks appear in your Ekoa account with the Jevellan label. Answer and approve them in Jevellan.</p>
      <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
        try { const next = await save('/hub/ekoa', EkoaStateSchema, 'PUT', { schema: 'ekoa-settings-input-v1', revision: state!.settings.revision, url, enabled, ...(token ? { token } : {}) }, signal); setState(next); message('Ekoa settings saved.'); }
        finally { setToken(''); }
      }); }}>
        <label>MCP URL<input disabled={!state || task.busy} type="url" required={enabled} placeholder="https://mcp.ekoa.io/mcp" value={url} onChange={event => setUrl(event.target.value)} /></label>
        <label>Ekoa token<input disabled={!state || task.busy} type="password" autoComplete="off" spellCheck={false} value={token} placeholder={state?.tokenSaved ? 'Saved · enter a replacement' : 'Enter your Ekoa token'} onChange={event => setToken(event.target.value)} /></label>
        <p className="muted">{state?.tokenSaved ? 'Token saved in the hub vault.' : 'No token saved.'} Ekoa must offer task access with read and write permission.</p>
        <label className="check"><input disabled={!state || task.busy} type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Mirror tasks to Ekoa</label>
        <div className="actions"><button disabled={!state || task.busy}>Save</button><button type="button" className="secondary" disabled={!state || task.busy} onClick={() => void task.run(async signal => setState(await api('/hub/ekoa/test', EkoaStateSchema, 'POST', empty, { signal, waitForHub: true })))}>Test connection</button>
          {state?.tokenSaved && <button type="button" className="secondary" disabled={task.busy} onClick={() => void task.run(async signal => { setState(await save('/hub/ekoa', EkoaStateSchema, 'PUT', { schema: 'ekoa-settings-input-v1', revision: state.settings.revision, url, enabled: false, removeToken: true }, signal)); setEnabled(false); })}>Remove token</button>}
        </div>
      </form>
    </section>
    {state?.connection && <section className="card" aria-label="Ekoa connection"><h2>{state.connection.status === 'connected' ? 'Connected' : 'Connection blocked'}</h2>{state.connection.reason && <p>{state.connection.reason}</p>}
      {!!state.connection.tools.length && <details><summary>Available tools</summary><ul>{state.connection.tools.map(name => <li key={name}>{name}</li>)}</ul></details>}
    </section>}
    {!!state?.mirrors.length && <section className="card"><h2>Mirrored tasks</h2><p>{state.mirrors.filter(row => row.state === 'open').length} open · {state.mirrors.filter(row => row.state === 'completed').length} completed</p>
      {state.mirrors.map(row => <p key={row.id}><strong>{row.title ?? row.kind}</strong> · {row.state}</p>)}
      {state.mirrors.filter(row => row.error).map(row => <p className="notice" key={row.id}>{row.error} {row.retryAt ? 'Jevellan will retry.' : ''}</p>)}
    </section>}
  </div>;
}
