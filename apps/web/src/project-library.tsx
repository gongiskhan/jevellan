import {projectLibraryView,projectLibraryMessageContext,projectLibraryMessage,projectLibraryMessageImage,projectLibraryMessageReadNeeded,projectLibraryMessageRead,type ProjectLibraryMessageContext} from '@jevellan/core/client';
import {PROJECT_LIBRARY_POLICY,ProjectLibraryViewSchema,projectLibraryReadCache,projectLibraryReadFailure,projectLibraryFilter,type ProjectLibraryView,type ProjectLibraryFilter} from '@jevellan/core/client';
import {projectAttachmentAdmission,projectAttachmentUpload,projectAttachmentPreparation,projectAttachmentMessage,ProjectAttachmentMessageSchema} from '@jevellan/core/client';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { EmptySchema, ErrorDocumentSchema, ProjectLibraryItemSchema, type ProjectLibraryItem } from '@jevellan/core/client';
import { api, ApiError } from './api.js';
import { Markdown, Modal, dateTime, useTask } from './components.js';
import { Icon } from './icons.js';
import * as copy from './project-work-copy.js';
const base = (projectId: string) => `/api/projects/${projectId}/library`;
export const libraryContent = (projectId: string, id: string) => `${base(projectId)}/${id}/content`;
const reads = projectLibraryReadCache();
export function libraryView(projectId: string, reload = false) { return reads.read(projectId, () => api(`${base(projectId)}/view`, ProjectLibraryViewSchema), reload); }
export async function libraryItems(projectId: string, reload = false): Promise<ProjectLibraryItem[]> { return (await libraryView(projectId, reload)).rows.map(row => row.item); }
export const fileSize = copy.libraryFileSize;
export async function uploadLibrary(projectId: string, file: File, signal?: AbortSignal) {
  const upload = projectAttachmentUpload({ schema: 'project-attachment-upload-request-v1', projectId, name: file.name, mime: file.type, size: file.size });
  const response = await fetch(upload.path, { method: 'PUT', credentials: 'same-origin', redirect: 'error', body: file, headers: { 'Content-Type': upload.mime }, ...(signal ? { signal } : {}) });
  const value: unknown = await response.json(); if (!response.ok) { const error = ErrorDocumentSchema.safeParse(value); throw new ApiError(error.success ? error.data.message : copy.LIBRARY_UPLOAD_FAILED, response.status); }
  const item = ProjectLibraryItemSchema.parse(value); reads.invalidate(projectId); return item;
}
type Attached = { key: number; file: File; item?: ProjectLibraryItem };
/** Uploaded entries survive a failed send; a retry never uploads those bytes twice. */
export function useProjectAttachments(projectId: string, onError: (error: unknown) => void) {
  const [entries, setEntries] = useState<Attached[]>([]), sequence = useRef(0);
  const preparation = useRef<ReturnType<typeof projectAttachmentPreparation> | undefined>(undefined); preparation.current ??= projectAttachmentPreparation();
  const add = (files: File[]) => setEntries(previous => { const admission = projectAttachmentAdmission({ schema: 'project-attachment-admission-request-v1', existingCount: previous.length, files: files.map(file => ({ size: file.size })) }); if (!admission.allowed) { queueMicrotask(() => onError(new Error(admission.refusal!))); return previous; } return [...previous, ...files.map(file => ({ key: ++sequence.current, file }))]; });
  return { entries, add, remove: (key: number) => setEntries(previous => previous.filter(entry => entry.key !== key)),
    paste: (event: ClipboardEvent) => { const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; }); if (files.length) { event.preventDefault(); add(files); } },
    dragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); },
    drop: (event: DragEvent) => { if (event.dataTransfer.files.length) { event.preventDefault(); add([...event.dataTransfer.files]); } },
    prepare: async (text: string, signal: AbortSignal) => {
      const selected = [...entries]; const items: ProjectLibraryItem[] = [];
      for (const entry of selected) { const item = entry.item ?? await uploadLibrary(projectId, entry.file, signal); entry.item = item; setEntries(previous => previous.map(row => row.key === entry.key ? { ...row, item } : row)); items.push(item); }
      const snapshot = { schema: 'project-attachment-context-v1', projectId, text, entries: selected.map((entry, i) => ({ key: entry.key, itemId: items[i]!.id })) };
      const message = items.length ? await preparation.current!.prepare(snapshot, request => api(`${base(projectId)}/attachments`, ProjectAttachmentMessageSchema, 'POST', request, { signal, waitForHub: true })) : projectAttachmentMessage(projectId, text, []);
      return { text: message.text,
        clear: () => { preparation.current!.clear(snapshot); setEntries(previous => previous.filter(row => !selected.some(entry => entry.key === row.key))); } };

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
  const empty = useMemo(() => projectLibraryMessageContext(projectLibraryView({ schema: 'project-library-source-v1', projectId, items: [], threads: [] })), [projectId]);
  const [context, setContext] = useState<ProjectLibraryMessageContext>(), [image, setImage] = useState<ProjectLibraryItem>();
  const captured = context?.projectId === projectId ? context : empty;
  useEffect(() => { if (!projectLibraryMessageReadNeeded(text)) return; let active = true; void projectLibraryMessageRead(captured, () => libraryView(projectId)).then(value => { if (active) setContext(value); }); return () => { active = false; }; }, [projectId, text]);
  const message = useMemo(() => projectLibraryMessage(captured, { schema: 'project-library-message-input-v1', projectId, text }), [captured, projectId, text]);
  const openImage = (ref: string) => { const target = projectLibraryMessageImage(captured, ref); if (target.kind === 'library') setImage(target.item); else if (target.kind === 'external') onOpenImage?.(target.ref); };
  return <><Markdown {...(onOpenImage || message.attachments.length ? { onOpenImage: openImage } : {})}>{message.text}</Markdown>{message.attachments.length > 0 && <div className="pw-library-chips">{message.attachments.map(item => item.kind === 'image' ? <button type="button" className="pw-library-thumb" key={item.id} onClick={() => openImage(`library/${item.path}`)}><img src={item.contentPath} alt={item.name} /><span>{item.name}</span></button> : <a className="chip" key={item.id} href={item.contentPath} target="_blank" rel="noreferrer">{item.name} · {item.sizeLabel}</a>)}</div>}
    {image && <LibraryImage projectId={projectId} items={captured.images} active={image} choose={setImage} close={() => setImage(undefined)} />}</>;
}
export function ProjectLibraryPanel({ projectId, onError }: { projectId: string; onError(error: unknown): void }) {
  const [view, setView] = useState<ProjectLibraryView>(), [filter, setFilter] = useState<ProjectLibraryFilter>('all'), [image, setImage] = useState<ProjectLibraryItem>();
  const input = useRef<HTMLInputElement>(null), task = useTask(onError), [removing, setRemoving] = useState<ProjectLibraryView['rows'][number]>();
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const load = async () => { const value = await libraryView(projectId, true); if (currentProject.current === projectId) setView(value); };
  useEffect(() => {
    let active = true;
    const read = async () => { const value = await libraryView(projectId, true); if (active) setView(value); };
    const failed = (phase: 'initial' | 'poll') => (error: unknown) => { if (projectLibraryReadFailure({ schema: 'project-library-read-failure-context-v1', phase }).route === 'surface') onError(error); };
    void read().catch(failed('initial'));
    const timer = setInterval(() => { void read().catch(failed('poll')); }, PROJECT_LIBRARY_POLICY.pollMs);
    return () => { active = false; clearInterval(timer); };
  }, [projectId]);
  const model = useMemo(() => view?.projectId === projectId ? projectLibraryFilter(view, filter) : undefined, [view, projectId, filter]);
  return <section className="pw-section pw-library"><div className="pw-section-heading"><h3>{model?.labels.title ?? copy.LIBRARY}</h3><button type="button" disabled={task.busy} onClick={() => input.current?.click()}>{model?.labels.upload ?? copy.LIBRARY_UPLOAD}</button><input ref={input} type="file" multiple hidden onChange={event => { const files = [...event.target.files ?? []]; event.target.value = ''; void task.run(async signal => { for (const file of files) await uploadLibrary(projectId, file, signal); await load(); }); }} /></div>
    <div className="actions">{model?.filters.map(choice => <button type="button" className="secondary" key={choice.value} aria-pressed={filter === choice.value} onClick={() => setFilter(choice.value)}>{choice.label}</button>)}</div>
    {model?.isEmpty && <p className="pw-empty">{model.labels.empty}</p>}
    {model?.rows.map(row => <article className="pw-library-row" key={row.item.id}>
      {row.kind === 'image' ? <button type="button" className="pw-library-thumb" aria-label={row.openLabel} onClick={() => setImage(row.item)}><img src={row.contentPath} alt="" /></button> : <Icon name="file" />}
      <div><strong>{row.item.name}</strong><p className="muted small-text">{row.sizeLabel} · {row.originLabel} · {dateTime(row.item.createdAt)}</p>{row.item.note && <p>{row.item.note}</p>}
        <div className="actions"><a href={row.contentPath} target="_blank" rel="noreferrer">{model.labels.open}</a><a href={row.downloadPath}>{model.labels.download}</a><button type="button" className="text-button" disabled={task.busy} onClick={() => setRemoving(row)}>{model.labels.delete}</button></div></div>
    </article>)}
    {removing && <Modal title={removing.deleteTitle} close={() => setRemoving(undefined)}><div className="actions"><button type="button" disabled={task.busy} onClick={() => { void task.run(async signal => { await api(removing.commandPath, EmptySchema, 'POST', removing.deleteCommand, { signal }); reads.invalidate(removing.item.projectId); setRemoving(undefined); await load(); }); }}>{model?.labels.delete ?? copy.LIBRARY_DELETE}</button><button type="button" className="secondary" onClick={() => setRemoving(undefined)}>{copy.CANCEL}</button></div></Modal>}
    {image && model && <LibraryImage projectId={model.projectId} items={model.images} active={image} choose={setImage} close={() => setImage(undefined)} />}
  </section>;
}
