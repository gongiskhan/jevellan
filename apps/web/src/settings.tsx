import { useEffect, useRef, useState } from 'react';
import {
  ConfigurationEditorViewSchema, ConfigurationImportViewSchema, ConfigurationYamlViewSchema, type ConfigurationEditorView, type ConfigurationImportView,
  ConfigRevisionSchema,
  DeviceAboutViewSchema, type DeviceAboutView,
} from '@jevellan/core/client';
import { api } from './api.js';
import { PwaInstallCard } from './pwa.js';
import { SectionHeading, dateTime, useTask, useRequestId, type PageProps } from './components.js';

export function ConfigurationPage(props: PageProps) {
  const [view, setView] = useState<ConfigurationEditorView>(), [yaml, setYaml] = useState<string>();
  const [importing, setImporting] = useState(false), [source, setSource] = useState(''), [preview, setPreview] = useState<ConfigurationImportView>();
  const task = useTask(props.onError), requestId = useRequestId(), previewRequest = useRef<AbortController | undefined>(undefined), previewEpoch = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/config/editor', ConfigurationEditorViewSchema, 'GET', undefined, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setView(result); }).catch(error => { if (!controller.signal.aborted) props.onError(error); });
    return () => controller.abort();
  }, [props.data.config.revision, props.onError]);
  useEffect(() => () => { previewRequest.current?.abort(); }, []);
  const invalidatePreview = () => { previewEpoch.current++; previewRequest.current?.abort(); previewRequest.current = undefined; setPreview(undefined); };
  const validate = () => void task.run(async signal => {
    const controller = new AbortController(), epoch = ++previewEpoch.current;
    previewRequest.current?.abort(); previewRequest.current = controller;
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    try {
      const next = await api(view!.import.previewPath, ConfigurationImportViewSchema, 'POST', { schema: 'config-import-v1', yaml: source }, { signal: controller.signal });
      if (!controller.signal.aborted && epoch === previewEpoch.current) setPreview(next);
    } finally { signal.removeEventListener('abort', abort); if (previewRequest.current === controller) previewRequest.current = undefined; }
  });
  if (!view) return <p role="status">Loading configuration…</p>;
  return <>
    <SectionHeading title={view.title}><div className="actions">
      <button className="secondary" onClick={() => void task.run(async signal => { if (yaml !== undefined) { setYaml(undefined); return; } setYaml((await api(view.yaml.readPath, ConfigurationYamlViewSchema, 'GET', undefined, { signal })).yaml); })}>{yaml === undefined ? view.yaml.showLabel : view.yaml.hideLabel}</button>
      <a className="button-link secondary" href={view.yaml.downloadPath} download={view.yaml.downloadName}>Export</a>
      <button onClick={() => setImporting(true)}>{view.import.openLabel}</button>
    </div></SectionHeading>
    <p className="intro">{view.intro}</p>
    {yaml !== undefined && <section className="card"><h2>{view.yaml.title}</h2><pre>{yaml}</pre></section>}
    {importing && <section className="card"><h2>{view.import.title}</h2>
      <form onSubmit={event => { event.preventDefault(); validate(); }}>
        <label>{view.import.sourceLabel}<textarea aria-label={view.import.sourceLabel} required rows={10} maxLength={view.import.maxLength} className="code-editor" value={source} onChange={event => { setSource(event.target.value); invalidatePreview(); }} /></label>
        <div className="actions"><button disabled={task.busy}>{view.import.validateLabel}</button><button className="secondary" type="button" onClick={() => { invalidatePreview(); setImporting(false); }}>{view.import.cancelLabel}</button></div>
      </form>
      {preview && <div className="import-preview"><h3>{preview.heading}</h3><ul>{preview.preview.changedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        <div className="diff-columns"><div><h4>Current</h4><pre>{preview.preview.before}</pre></div><div><h4>Imported</h4><pre>{preview.preview.after}</pre></div></div>
        <button disabled={task.busy || !preview.canApply} onClick={() => void task.run(async signal => {
          if (!preview.canApply || !preview.write) return;
          const plan = preview.write;
          await api(plan.path, ConfigRevisionSchema, plan.method, { ...plan.body, clientRequestId: `config_${requestId(plan.body)}` }, { signal, waitForHub: true });
          const notice = preview.savedNotice; invalidatePreview(); setImporting(false); setYaml(undefined); setSource(''); await props.reload(signal); props.message(notice);
        })}>{view.import.applyLabel}</button>
      </div>}
    </section>}
    <section className="card"><h2>{view.historyTitle}</h2><div className="revision-list">{view.rows.map(row => <div key={row.revision}><strong>{row.label}</strong><span>{dateTime(row.at)}</span><span className="muted">{row.deviceLabel} · {row.sourceLabel}</span></div>)}</div></section>
  </>;
}
export { DecisionsPage } from './decisions-settings.js';
export function AboutPage(props: PageProps) {
  const [view, setView] = useState<DeviceAboutView>();
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/config/about', DeviceAboutViewSchema, 'GET', undefined, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setView(result); }).catch(error => { if (!controller.signal.aborted) props.onError(error); });
    return () => controller.abort();
  }, [props.data.devices, props.onError]);
  return (
    <>
      <SectionHeading title="About" />
      <PwaInstallCard />
      <section className="card">
        <h2>Jevellan</h2>
        <p>Autonomous development, coordinated.</p>
        <p className="muted">
          Version{' '}
          {view?.currentVersion}
        </p>
        <button className="secondary" onClick={() => props.navigate('/setup')}>
          Open setup guide
        </button>
        <h3>Update</h3>
        <code>{view?.commands.update}</code>
        <h3>Uninstall</h3>
        <code>{view?.commands.uninstall}</code>
      </section>
    </>
  );
}
