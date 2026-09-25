import { useState } from 'react';
import { z } from 'zod';
import { JevConnectionSchema, SecretSummarySchema } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { useSettingsSave, useTask, type PageProps } from './components.js';

export function JevConnection(props: Pick<PageProps, 'data' | 'reload' | 'onError' | 'message'>) {
  const save = useSettingsSave(); const task = useTask(props.onError);
  const [key, setKey] = useState(''); const [connection, setConnection] = useState<z.infer<typeof JevConnectionSchema>>();
  return <section className="card"><h2>Jev connection</h2>
    {props.data.jev.saved ? <p className="saved-secret">Saved · ••••{props.data.jev.lastFour}</p> : <p className="notice">Add your Jev key in Settings → Decisions. Until then you pick each step yourself.</p>}
    <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
      try { await save('/hub/secrets/jev', SecretSummarySchema, 'PUT', { schema: 'save-secret-v1', value: key }, signal); await props.reload(signal); setConnection(undefined); props.message('Jev key saved.'); }
      finally { setKey(''); }
    }); }}><div className="inline-form"><label>Jev key<input type="password" autoComplete="off" required value={key} onChange={event => setKey(event.target.value)}/></label><button disabled={task.busy}>Save key</button></div></form>
    <button className="secondary" disabled={task.busy || !props.data.jev.saved} onClick={() => void task.run(async signal => setConnection(await api('/api/decisions/check', JevConnectionSchema, 'POST', empty, { signal, waitForHub: true })))}>Test connection</button>
    {connection && <div role="status" className={connection.status === 'connected' ? 'success' : 'notice'}>
      {connection.status === 'connected' ? <><p>Connected to Jev.</p><p className="small-text">Saved model: {connection.configuredModel}. Returned models: {connection.availableModels.join(', ') || 'none listed'}.</p></> : <p>Jev is unavailable ({connection.reason}).</p>}
      <p className="small-text">Latency: {connection.latencyMs} ms.</p>
    </div>}
  </section>;
}
