import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { EmptySchema, ErrorDocumentSchema, LibraryListSchema, ProjectLibraryItemSchema, type ProjectLibraryItem } from '@jevellan/core/client';
import { api, ApiError } from './api.js';
import { Markdown, Modal, dateTime, useTask } from './components.js';
import { Icon } from './icons.js';
import * as copy from './project-work-copy.js';
const base = (projectId: string) => `/api/projects/${projectId}/library`;
export const libraryContent = (projectId: string, id: string) => `${base(projectId)}/${id}/content`;
const lists = new Map<string, { at: number; promise: Promise<ProjectLibraryItem[]> }>();
export async function libraryItems(projectId: string, reload = false): Promise<ProjectLibraryItem[]> {
  if (reload) lists.delete(projectId); const cached = lists.get(projectId); if (cached && Date.now() - cached.at < 2000) return cached.promise;
  const pending = (async () => { const items: ProjectLibraryItem[] = []; let cursor: string | null = null;
    do { const page: ReturnType<typeof LibraryListSchema.parse> = await api(`${base(projectId)}${cursor ? `?after=${cursor}` : ''}`, LibraryListSchema); items.push(...page.items); cursor = page.next; } while (cursor); return items;
  })(); lists.set(projectId, { at: Date.now(), promise: pending }); pending.catch(() => { if (lists.get(projectId)?.promise === pending) lists.delete(projectId); }); return pending;
}
export const fileSize = copy.libraryFileSize;
export async function uploadLibrary(projectId: string, file: File, signal?: AbortSignal) {
  if (file.size > 50 * 1024 * 1024) throw new Error(copy.LIBRARY_TOO_LARGE);
  const response = await fetch(`${base(projectId)}/uploads/${encodeURIComponent(file.name)}`, { method: 'PUT', credentials: 'same-origin', redirect: 'error', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' }, ...(signal ? { signal } : {}) });
  const value: unknown = await response.json(); if (!response.ok) { const error = ErrorDocumentSchema.safeParse(value); throw new ApiError(error.success ? error.data.message : copy.LIBRARY_UPLOAD_FAILED, response.status); }
  const item = ProjectLibraryItemSchema.parse(value); lists.delete(projectId); return item;
}
type Attached = { key: number; file: File; item?: ProjectLibraryItem };
/** Uploaded entries survive a failed send; a retry never uploads those bytes twice. */
export function useProjectAttachments(projectId: string, onError: (error: unknown) => void) {
  const [entries, setEntries] = useState<Attached[]>([]), sequence = useRef(0);
  const add = (files: File[]) => setEntries(previous => { if (previous.length + files.length > 10) { queueMicrotask(() => onError(new Error(copy.ATTACHMENT_LIMIT))); return previous; } if (files.some(file => file.size > 50 * 1024 * 1024)) { queueMicrotask(() => onError(new Error(copy.LIBRARY_TOO_LARGE))); return previous; } return [...previous, ...files.map(file => ({ key: ++sequence.current, file }))]; });
  return { entries, add, remove: (key: number) => setEntries(previous => previous.filter(entry => entry.key !== key)),
    paste: (event: ClipboardEvent) => { const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; }); if (files.length) { event.preventDefault(); add(files); } },
    dragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); },
    drop: (event: DragEvent) => { if (event.dataTransfer.files.length) { event.preventDefault(); add([...event.dataTransfer.files]); } },
    prepare: async (text: string, signal: AbortSignal) => {
      const selected = [...entries]; const items: ProjectLibraryItem[] = [];
      for (const entry of selected) { const item = entry.item ?? await uploadLibrary(projectId, entry.file, signal); entry.item = item; setEntries(previous => previous.map(row => row.key === entry.key ? { ...row, item } : row)); items.push(item); }
      return { text: `${text.trim()}${items.length ? `\n\n${items.map(item => `Attached file: library/${item.path} (${item.mime}, ${fileSize(item.size)})`).join('\n')}` : ''}`.trim(),
        clear: () => setEntries(previous => previous.filter(row => !selected.some(entry => entry.key === row.key))) };
    } };
}
export function AttachmentControls({ attachments, disabled }: { attachments: ReturnType<typeof useProjectAttachments>; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="pw-attachments"><button type="button" className="secondary pw-attach" aria-label={copy.ATTACH_FILES} title={copy.ATTACH_FILES} disabled={disabled} onClick={() => input.current?.click()}><Icon name="attachment" size={16} /><span>{copy.ATTACH_FILES}</span></button>
    <input ref={input} type="file" multiple hidden onChange={event => { attachments.add([...event.target.files ?? []]); event.target.value = ''; }} />
    {attachments.entries.map(entry => <span className="chip pw-attachment" key={entry.key}>{entry.file.name} <small>{fileSize(entry.file.size)}</small><button type="button" className="text-button" disabled={disabled} aria-label={copy.removeAttachment(entry.file.name)} onClick={() => attachments.remove(entry.key)}>×</button></span>)}
  </div>;
}
export function LibraryImage({ projectId, items, active, close, choose }: { projectId: string; items: ProjectLibraryItem[]; active: ProjectLibraryItem; close(): void; choose(item: ProjectLibraryItem): void }) {
  const index = items.findIndex(item => item.id === active.id); const touch = useRef<number | null>(null);
  const move = (delta: number) => choose(items[(index + delta + items.length) % items.length]!);
  return <Modal title={active.name} close={close}><div className="pw-library-viewer" onTouchStart={event => { touch.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={event => { const end = event.changedTouches[0]?.clientX; if (touch.current !== null && end !== undefined && Math.abs(end - touch.current) > 50) move(end < touch.current ? 1 : -1); touch.current = null; }}>
    <img src={libraryContent(projectId, active.id)} alt={active.name} /><div className="actions"><button type="button" className="secondary" disabled={items.length < 2} onClick={() => move(-1)}>{copy.LIBRARY_PREVIOUS}</button><span>{index + 1} / {items.length}</span><button type="button" className="secondary" disabled={items.length < 2} onClick={() => move(1)}>{copy.LIBRARY_NEXT}</button></div>
  </div></Modal>;
}
export function LibraryMessage({ projectId, text, onOpenImage }: { projectId: string; text: string; onOpenImage?: ((ref: string) => void) | undefined }) {
  const [items, setItems] = useState<ProjectLibraryItem[]>([]), [image, setImage] = useState<ProjectLibraryItem>();
  const paths = [...text.matchAll(/^Attached file: library\/(.+) \([^\n]+\)$/gmu)].map(match => match[1]!);
  useEffect(() => { if (!text.includes('library/')) return; let active = true; void libraryItems(projectId).then(value => { if (active) setItems(value); }).catch(() => undefined); return () => { active = false; }; }, [projectId, text]);
  const attached = items.filter(item => paths.includes(item.path) || text.includes(`library/${item.path}`));
  const openImage = (ref: string) => { const item = items.find(item => ref === `library/${item.path}`); if (item) setImage(item); else if (!ref.startsWith('library/')) onOpenImage?.(ref); }; 
  return <><Markdown {...(onOpenImage || attached.length ? { onOpenImage: openImage } : {})}>{text.split('\n').filter(line => !attached.some(item => line.startsWith(`Attached file: library/${item.path} (`))).join('\n')}</Markdown>{attached.length > 0 && <div className="pw-library-chips">{attached.map(item => item.mime.startsWith('image/') ? <button type="button" className="pw-library-thumb" key={item.id} onClick={() => setImage(item)}><img src={libraryContent(projectId, item.id)} alt={item.name} /><span>{item.name}</span></button> : <a className="chip" key={item.id} href={libraryContent(projectId, item.id)} target="_blank" rel="noreferrer">{item.name} · {fileSize(item.size)}</a>)}</div>}
    {image && <LibraryImage projectId={projectId} items={items.filter(item => item.mime.startsWith('image/'))} active={image} choose={setImage} close={() => setImage(undefined)} />}</>;
}
export function ProjectLibraryPanel({ projectId, threadTitle, onError }: { projectId: string; threadTitle(id: string): string; onError(error: unknown): void }) {
  const [items, setItems] = useState<ProjectLibraryItem[]>([]), [filter, setFilter] = useState<'all' | 'owner' | 'thread'>('all'), [image, setImage] = useState<ProjectLibraryItem>();
  const input = useRef<HTMLInputElement>(null), task = useTask(onError), [removing, setRemoving] = useState<ProjectLibraryItem>();
  const load = async () => setItems(await libraryItems(projectId, true));
  useEffect(() => { void load().catch(onError); const timer = setInterval(() => { void load().catch(() => undefined); }, 15_000); return () => clearInterval(timer); }, [projectId]);
  return <section className="pw-section pw-library"><div className="pw-section-heading"><h3>{copy.LIBRARY}</h3><button type="button" disabled={task.busy} onClick={() => input.current?.click()}>{copy.LIBRARY_UPLOAD}</button><input ref={input} type="file" multiple hidden onChange={event => { const files = [...event.target.files ?? []]; event.target.value = ''; void task.run(async signal => { for (const file of files) await uploadLibrary(projectId, file, signal); await load(); }); }} /></div>
    <div className="actions">{(['all', 'owner', 'thread'] as const).map(value => <button type="button" className="secondary" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{copy.LIBRARY_FILTERS[value]}</button>)}</div>
    {!items.length && <p className="pw-empty">{copy.LIBRARY_EMPTY}</p>}
    {items.filter(item => filter === 'all' || item.source === filter).map(item => <article className="pw-library-row" key={item.id}>
      {item.mime.startsWith('image/') ? <button type="button" className="pw-library-thumb" aria-label={copy.openLibraryFile(item.name)} onClick={() => setImage(item)}><img src={libraryContent(projectId, item.id)} alt="" /></button> : <Icon name="file" />}
      <div><strong>{item.name}</strong><p className="muted small-text">{fileSize(item.size)} · {item.source === 'owner' ? copy.LIBRARY_FROM_YOU : copy.libraryFromThread(threadTitle(item.threadId!))} · {dateTime(item.createdAt)}</p>{item.note && <p>{item.note}</p>}
        <div className="actions"><a href={libraryContent(projectId, item.id)} target="_blank" rel="noreferrer">{copy.LIBRARY_OPEN}</a><a href={`${libraryContent(projectId, item.id)}?download`}>{copy.LIBRARY_DOWNLOAD}</a><button type="button" className="text-button" disabled={task.busy} onClick={() => setRemoving(item)}>{copy.LIBRARY_DELETE}</button></div></div>
    </article>)}
    {removing && <Modal title={copy.deleteLibraryFile(removing.name)} close={() => setRemoving(undefined)}><div className="actions"><button type="button" disabled={task.busy} onClick={() => { void task.run(async signal => { await api(`${base(projectId)}/${removing.id}`, EmptySchema, 'DELETE', undefined, { signal }); setRemoving(undefined); await load(); }); }}>{copy.LIBRARY_DELETE}</button><button type="button" className="secondary" onClick={() => setRemoving(undefined)}>{copy.CANCEL}</button></div></Modal>}
    {image && <LibraryImage projectId={projectId} items={items.filter(item => item.mime.startsWith('image/'))} active={image} choose={setImage} close={() => setImage(undefined)} />}
  </section>;
}
