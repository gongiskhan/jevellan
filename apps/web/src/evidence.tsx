import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ConversationFileSchema, ConversationReadSchema } from '@jevellan/core/client';
import { api } from './api.js';
import { Markdown, Modal } from './components.js';
import { filePointer, storedPointer } from './evidence-refs.js';

export type EvidenceTarget = { ref: string; title?: string; stretch?: number | undefined; source?: 'step' | 'working-tree' | undefined; output?: boolean };
export function EvidenceLink({ value, open, file = false }: { value: string; open(ref: string): void; file?: boolean }) {
  if (/^https?:\/\//i.test(value)) return <a href={value} target="_blank" rel="noopener noreferrer">{value}</a>;
  return file || storedPointer(value) || filePointer(value) ? <button className="text-button evidence-link" onClick={() => open(value)}>{value}</button> : <code>{value}</code>;
}
type FileView = z.infer<typeof ConversationFileSchema>;
function FileContent({ value, open }: { value: FileView; open(ref: string): void }) {
  const highlighted = useRef<HTMLSpanElement>(null); const [source, setSource] = useState(Boolean(value.line));
  useEffect(() => { highlighted.current?.scrollIntoView({ block: 'center' }); }, [value]);
  const relativeLink = (ref: string) => {
    if (ref.startsWith('/') || storedPointer(ref)) { open(ref); return; }
    try { const url = new URL(ref, `https://project.invalid/${value.path}`); open(`${decodeURIComponent(url.pathname.slice(1))}${url.hash}`); } catch { open(ref); }
  };
  return <>
    <p className="muted small-text">{value.source === 'working-tree' ? 'Current working copy · not a saved step' : value.source === 'before-step' ? 'Before this step · file deleted by the step' : 'Recorded checkpoint'}{value.commit && <> · <code>{value.commit}</code></>}</p>
    {value.kind === 'image' ? <img className="evidence-image" src={`data:${value.mime};base64,${value.content}`} alt={value.path}/> : <>
      {value.kind === 'markdown' && <button className="text-button" onClick={() => setSource(!source)}>{source ? 'Rendered Markdown' : 'Show source'}</button>}
      {value.kind === 'markdown' && !source ? <Markdown onOpen={relativeLink}>{value.content}</Markdown> : <pre className="file-code" aria-label="File contents">{value.content.split('\n').map((line, index) => <span className={`file-line${index + 1 === value.line ? ' selected-line' : ''}`} key={index} ref={index + 1 === value.line ? highlighted : undefined}><span className="line-number" aria-hidden="true">{index + 1}</span><code>{line || ' '}</code></span>)}</pre>}
    </>}
  </>;
}
export function EvidencePanel({ id, target, close }: { id: string; target: EvidenceTarget; close(): void }) {
  const [current, setCurrent] = useState(target); const [file, setFile] = useState<FileView>(); const [document, setDocument] = useState<{ content: unknown }>(); const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setFile(undefined); setDocument(undefined); setError('');
    const load = async () => {
      try {
        if (storedPointer(current.ref)) { const value = await api(`/api/conversations/${id}/read?pointer=${encodeURIComponent(current.ref)}`, ConversationReadSchema); if (active) setDocument(value); }
        else { const params = new URLSearchParams({ ref: current.ref, stretch: String(current.stretch), source: current.source ?? 'step' }); const value = await api(`/api/conversations/${id}/file?${params}`, ConversationFileSchema); if (active) setFile(value); }
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'Evidence could not be opened.'); }
    }; void load(); return () => { active = false; };
  }, [id, current]);
  const open = (ref: string) => setCurrent({ ...current, ref, title: ref, output: false });
  return <Modal title={current.title ?? current.ref} close={close}>
    {error ? <p role="alert" className="error">{error}</p> : file ? <FileContent key={file.path} value={file} open={open}/> : document ? typeof document.content === 'string' && !current.output ? <Markdown onOpen={open}>{document.content}</Markdown> : <pre className="evidence-output">{typeof document.content === 'string' ? document.content : JSON.stringify(document.content, null, 2)}</pre> : <p role="status">Loading evidence…</p>}
    {!storedPointer(current.ref) && current.stretch && <div className="actions"><button className="text-button" disabled={current.source === 'working-tree'} onClick={() => setCurrent({ ...current, source: 'working-tree' })}>Open working copy</button><button className="text-button" disabled={current.source !== 'working-tree'} onClick={() => setCurrent({ ...current, source: 'step' })}>Open recorded step</button></div>}
  </Modal>;
}
