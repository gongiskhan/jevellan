import { useEffect, useState } from 'react';
import { MergeDocumentsViewSchema, type MergeDocument } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { clientId } from './client-id.js';
import { Modal } from './components.js';

export function MergeWhy({ projectId, threadId, commit }: { projectId: string; threadId: string; commit: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="text-button" onClick={() => setOpen(true)}>Why</button>
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
