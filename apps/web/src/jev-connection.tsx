import { useEffect, useState } from 'react';
import { JevConnectionSchema, JevConnectionViewSchema, SecretSummarySchema, type JevConnectionView } from '@jevellan/core/client';
import { api, empty, isCancelled } from './api.js';
import { useSettingsSave, useTask, type PageProps } from './components.js';

export function JevConnection(props: Pick<PageProps, 'data' | 'reload' | 'onError' | 'message'> & { changed?: () => void }) {
  const save = useSettingsSave(), task = useTask(props.onError);
  const [key, setKey] = useState(''), [view, setView] = useState<JevConnectionView>(), [refreshRevision, setRefreshRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/jev/connection', JevConnectionViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(setView).catch(error => { if (!isCancelled(error)) props.onError(error); });
    return () => controller.abort();
  }, [props.data.jev, props.data.config.revision, props.onError, refreshRevision]);
  return <section className="card">
    <h2>Jev connection</h2>
    {view?.savedText ? <p className="saved-secret">{view.savedText}</p> : view?.consequence ? <p className="notice">{view.consequence}</p> : <p className="muted">Loading Jev connection…</p>}
    <form onSubmit={event => {
      event.preventDefault();
      void task.run(async signal => {
        try {
          setView(undefined);
          await save('/hub/secrets/jev', SecretSummarySchema, 'PUT', { schema: 'save-secret-v1', value: key }, signal);
          await props.reload(signal); setRefreshRevision(value => value + 1); props.changed?.(); props.message('Jev key saved.');
        } finally { setKey(''); }
      });
    }}>
      <div className="inline-form"><label>Jev key<input type="password" autoComplete="off" required disabled={task.busy} value={key} onChange={event => setKey(event.target.value)} /></label><button disabled={task.busy}>Save key</button></div>
    </form>
    <button className="secondary" disabled={task.busy || !view?.canTest} onClick={() => void task.run(async signal => {
      await api('/api/decisions/check', JevConnectionSchema, 'POST', empty, { signal, waitForHub: true });
      setView(await api('/api/jev/connection', JevConnectionViewSchema, 'GET', undefined, { signal, waitForHub: true })); props.changed?.();
    })}>Test connection</button>
    {view?.result && <div role="status" className={view.result.tone}><p>{view.result.heading}</p>{view.result.lines.map((line, index) => <p className="small-text" key={index}>{line}</p>)}<p className="small-text">{view.result.latencyLine}</p></div>}
  </section>;
}
