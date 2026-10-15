import { useEffect, useState } from 'react';
import { MergeDocumentsViewSchema, type MergeDocument } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { clientId } from './client-id.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

export function MergeWhy({ projectId, threadId, commit, shadow, compact = false, buttonLabel = 'Why' }: { projectId: string; threadId: string; commit: string; shadow?: boolean | undefined; compact?: boolean; buttonLabel?: string }) {
  const [open, setOpen] = useState(false), [records, setRecords] = useState<MergeDocument[]>([]), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const path = `/api/projects/${projectId}/threads/${threadId}/pr`;
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void api(`${path}/route`, MergeDocumentsViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(view => setRecords(view.records), () => undefined); };
    refresh(); const timer = setInterval(refresh, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [path, commit]);
  const route = records.find(row => row.schema === 'merge-route-v1' && row.commit === commit);
  const correct = async (correction: 'should-have-asked' | 'did-not-need-asking') => {
    setBusy(true); try { const view = await api(`${path}/correction`, MergeDocumentsViewSchema, 'POST', { schema: 'merge-correction-input-v1', clientRequestId: clientId(), commit, correction }, { waitForHub: true }); setRecords(view.records); setNotice('Saved for future merge decisions.'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'The correction could not be saved.'); } finally { setBusy(false); }
  };
  return <>{shadow && route?.schema === 'merge-route-v1' && <span className="chip">Jev would: {route.route === 'merge' ? 'merge' : route.route === 'test-then-merge' ? 'test then merge' : 'ask you'}</span>}
    <button type="button" className={compact ? "icon-button" : "text-button"} aria-label={buttonLabel} title={buttonLabel} onClick={() => setOpen(true)}>{compact ? <Icon name="why" size={15} /> : buttonLabel}</button>
    {route && !compact && <><button type="button" className="text-button" disabled={busy} onClick={() => { void correct('should-have-asked'); }}>Should have asked me</button><button type="button" className="text-button" disabled={busy} onClick={() => { void correct('did-not-need-asking'); }}>Didn't need asking</button></>}
    {notice && <span role="status">{notice}</span>}
    {open && <MergeRouteDrawer projectId={projectId} threadId={threadId} commit={commit} close={() => setOpen(false)} />}</>;
}
function MergeRouteDrawer({ projectId, threadId, commit, close }: { projectId: string; threadId: string; commit: string; close(): void }) {
  const [records, setRecords] = useState<MergeDocument[]>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState('');
  const path = `/api/projects/${projectId}/threads/${threadId}/pr`;
  useEffect(() => {
    const controller = new AbortController();
    api(`${path}/route`, MergeDocumentsViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(view => setRecords(view.records), (failure: unknown) => { if (!isCancelled(failure)) setError(failure instanceof Error ? failure.message : 'The merge route could not be read.'); });
    return () => controller.abort();
  }, [path]);
  const route = records?.find(row => row.schema === 'merge-route-v1' && row.commit === commit);
  const correction = async (value: 'should-have-asked' | 'did-not-need-asking') => {
    if (busy) return; setBusy(true); setError('');
    try { const view = await api(`${path}/correction`, MergeDocumentsViewSchema, 'POST', { schema: 'merge-correction-input-v1', clientRequestId: clientId(), commit, correction: value }, { waitForHub: true }); setRecords(view.records); setSaved('Saved for future merge decisions.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The correction could not be saved.'); }
    finally { setBusy(false); }
  };
  return <Modal title="Why this merge route" close={close}>
    {error && <p role="alert">{error}</p>}
    {!records && !error && <p>Loading…</p>}
    {records && (!route || route.schema !== 'merge-route-v1') && <p>No merge route has been recorded at this commit.</p>}
    {route?.schema === 'merge-route-v1' && <>
      <p><strong>{route.route === 'merge' ? 'Merge' : route.route === 'test-then-merge' ? 'Test then merge' : 'Ask owner'}</strong> · {route.source === 'jev' ? 'Jev' : 'Guard'} · {route.state}</p>
      {route.reason && <p>{route.reason}</p>}
      <p>Checked commit <code>{route.commit}</code>. {route.packet.totalSize} added and removed lines across {route.packet.files.length} files.</p>
      {route.probabilities && <ul>{Object.entries(route.probabilities).map(([name, probability]) => <li key={name}>{name}: {Math.round(probability * 100)}%</li>)}</ul>}
      <p>Risky areas: {route.packet.riskyAreas || 'None specified.'}</p>
      <details><summary>Changed files and context</summary><p>{route.packet.summary}</p><ul>{route.packet.files.map(file => <li key={file.path}><code>{file.path}</code> +{file.additions} −{file.deletions}</li>)}</ul>
        {route.packet.corrections.length > 0 && <ul>{route.packet.corrections.map((sentence, index) => <li key={index}>{sentence}</li>)}</ul>}</details>
      {records?.filter(row => row.schema === 'verification-run-v1' && row.commit === commit).map(row => row.schema === 'verification-run-v1' && <details key={row.id}><summary>Basic verification: {row.state} · {row.modelLabel} · {row.providerChoice.replaceAll('-', ' ')}</summary>
        <p>{row.note}</p><ul>{row.report?.commands.map((command, index) => <li key={index}><code>{command}</code></li>)}</ul>{row.report?.failures.map((failure, index) => <div key={index}><p>{failure.what}</p><pre>{failure.output}</pre></div>)}</details>)}
      <div className="pw-pr-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { void correction('should-have-asked'); }}>Should have asked me</button><button type="button" className="secondary" disabled={busy} onClick={() => { void correction('did-not-need-asking'); }}>Didn't need asking</button></div>
      {saved && <p role="status">{saved}</p>}
    </>}
  </Modal>;
}
