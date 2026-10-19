import { useEffect, useState } from 'react';
import { MergeDocumentsViewSchema, type MergeDocument } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Modal } from './components.js';
export function LandingWhy({ projectId, threadId }: { projectId: string; threadId: string }) {
  const [open, setOpen] = useState(false), [records, setRecords] = useState<MergeDocument[]>([]), [error, setError] = useState('');
  const path = `/api/projects/${projectId}/threads/${threadId}/landing`;
  useEffect(() => { if (!open) return; const controller = new AbortController();
    void api(`${path}/route`, MergeDocumentsViewSchema, 'GET', undefined, { signal: controller.signal }).then(view => setRecords(view.records), failure => { if (!controller.signal.aborted) setError(String(failure)); });
    return () => controller.abort();
  }, [open, path]);
  const route = records.filter(row => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at))[0];
  const correct = async (correction: 'should-have-asked' | 'did-not-need-asking') => {
    if (!route) return;
    try { const view = await api(`${path}/correction`, MergeDocumentsViewSchema, 'POST', { schema: 'landing-correction-input-v1', clientRequestId: clientId(), commit: route.commit, correction }); setRecords(view.records); setError('Saved for future landing decisions.'); }
    catch (failure) { setError(String(failure)); }
  };
  return <><button className="text-button" onClick={() => setOpen(true)}>Why this landing</button>{open && <Modal title="Why this landing" close={() => setOpen(false)}>
    {error && <p role="status">{error}</p>}{!route && <p>No landing route recorded yet.</p>}
    {route?.schema === 'landing-route-v1' && <><p><strong>{route.route}</strong> · {route.source} · {route.state}</p><p>{route.reason}</p><p>Checked commit <code>{route.checkedCommit ?? route.commit}</code></p>
      <ul>{route.packet.checks.map(check => <li key={check.name}>{check.name}: {check.passed ? 'passed' : 'failed'}</li>)}</ul>
      <p>Risky areas: {route.packet.riskyAreas || 'None specified.'}</p><p>{route.packet.summary}</p>
      <details><summary>Changed files and corrections</summary><ul>{route.packet.files.map(file => <li key={file.path}>{file.path}: {file.bytes} bytes, +{file.additions} −{file.deletions}</li>)}</ul>{route.packet.corrections.map((text, i) => <p key={i}>{text}</p>)}</details>
      <button className="secondary" onClick={() => { void correct('should-have-asked'); }}>Should have asked me</button><button className="secondary" onClick={() => { void correct('did-not-need-asking'); }}>Didn't need asking</button></>}
    </Modal>}</>;
}
