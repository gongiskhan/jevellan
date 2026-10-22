import {ContextEditorSchema,ContextEditorReceiptSchema,ContextEditorReviewSchema,contextEditorPolicy,contextEditorWithUi,contextEditorAttempt,contextEditorAccepted} from '@jevellan/core/client';
import { ProjectForm } from './project-definition-editor.js';
export { ProjectForm };
import { ProjectDefinitionsViewSchema, GlobalThreadLimitEditorSchema, ConfigRevisionSchema, type ProjectDefinitionsView } from '@jevellan/core/client';
import { BranchChangeNotice } from './branch-change-notice.js';
import { clientId } from './client-id.js';
import { Fragment, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  MemoryNoteSchema,
  MemorySearchSchema,
  ProjectMemoryViewSchema, ProjectMemoryResultSchema, ProjectWorkSettingsViewSchema,
  ProjectViewSchema,
  type Project,
} from '@jevellan/core/client';
import { timeStamp } from './time.js';
import { api, isCancelled } from './api.js';
import { OPEN } from './project-work-copy.js';
import {
  Markdown,
  Modal,
  SectionHeading,
  dateTime,
  useSettingsSave,
  useTask,
  type PageProps,
} from './components.js';

type ProjectView = z.infer<typeof ProjectViewSchema>;
export function ProjectsPage(props: PageProps & { embedded?: boolean }) {
  const [model, setModel] = useState<ProjectDefinitionsView>(), [limit, setLimit] = useState<z.infer<typeof GlobalThreadLimitEditorSchema>>(), [globalLimit, setGlobalLimit] = useState('');
  const [editing, setEditing] = useState<ProjectView | 'new'>(), [memory, setMemory] = useState<{ project: Project; isPublic: boolean }>(), [context, setContext] = useState<Project>();
  const globalSave = useTask(props.onError), save = useSettingsSave();
  const reload = async (signal?: AbortSignal) => setModel(await api('/api/projects/view', ProjectDefinitionsViewSchema, 'GET', undefined, { signal, waitForHub: true }));
  const reloadLimit = async (signal?: AbortSignal) => { const next = await api('/api/config/limits', GlobalThreadLimitEditorSchema, 'GET', undefined, { signal, waitForHub: true }); setLimit(next); setGlobalLimit(String(next.input.value)); };
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal).catch(error => { if (!controller.signal.aborted) props.onError(error); });
    void reloadLimit(controller.signal).catch(error => { if (!controller.signal.aborted) props.onError(error); });
    return () => { controller.abort(); };
  }, [props.onError]);
  return <>
    {props.embedded ? <div className="setup-project-actions"><button onClick={() => setEditing('new')}>Add project</button></div> : <><SectionHeading title="Projects"><div className="actions"><button className="secondary" onClick={() => props.navigate('/settings/git')}>Git settings</button><button onClick={() => setEditing('new')}>Add project</button></div></SectionHeading><p className="intro">Choose where your agents work, how changes reach git, and where project memory lives.</p></>}
    {!props.embedded && limit && <section className="card"><h2>{limit.title}</h2><form onSubmit={event => { event.preventDefault(); void globalSave.run(async signal => {
      await save(limit.write.path, ConfigRevisionSchema, limit.write.method, { ...limit.write.body, value: globalLimit }, signal);
      await props.reload(signal); await reloadLimit(signal); props.message(limit.savedNotice);
    }); }}><label>{limit.input.label}<input type="number" min={limit.input.min} max={limit.input.max} step={limit.input.step} required disabled={globalSave.busy} value={globalLimit} onChange={event => setGlobalLimit(event.target.value)} /></label><p className="small-text">{limit.help}</p><button disabled={globalSave.busy}>Save thread limit</button></form></section>}
    {model?.vault && !props.embedded && <VaultStatus vault={model.vault} />}
    {model && !model.projects.length && <p className="empty-inline">Add a checked-out project to start work.</p>}
    <div className="project-list">{model?.projects.map(row => <section className="card project-card" key={row.view.project.id}>
      <div className="card-heading"><h2>{row.view.project.name}</h2><button className="secondary small" onClick={() => setEditing(row.view)}>Edit</button></div>
      <div className="model-chips">{row.chips.map((chip, index) => <span className={`chip ${ { normal: '', dim: 'dim', blocked: 'state-blocked' }[chip.tone]}`} key={index}>{chip.label}</span>)}</div>
      <p className={row.checkedOutHere ? 'project-path' : 'project-path muted'}>{row.path}</p>
      {row.publicMemoryNotice && <PublicMemoryNotice />}
      <div className="actions">{!props.embedded && <button className="secondary small" onClick={() => props.navigate(`/projects/${row.view.project.id}`)}>{OPEN}</button>}<button className="secondary small" onClick={() => setMemory({ project: row.view.project, isPublic: row.publicMemoryNotice })}>Browse memory</button><button className="secondary small" disabled={!row.canContext} onClick={() => setContext(row.view.project)}>Context</button></div>
    </section>)}</div>
    {editing && <ProjectForm {...props} row={editing === 'new' ? undefined : editing} knownPublic={false} close={() => setEditing(undefined)} saved={async signal => { await reload(signal); setEditing(undefined); props.message('Project saved.'); }} />}
    {memory && <MemoryViewer project={memory.project} isPublic={memory.isPublic} onError={props.onError} close={() => setMemory(undefined)} />}
    {context && <ContextPanel {...props} project={context} close={() => { setContext(undefined); void reload().catch(props.onError); }} />}
  </>;
}
function VaultStatus({ vault }: { vault: NonNullable<ProjectDefinitionsView['vault']> }) {
  const synced = vault.lastSyncAt ? timeStamp(vault.lastSyncAt) : null;
  return <section className="card vault-status" aria-label="Vault"><div className="card-heading"><h2>Vault</h2><span className={`chip ${vault.blocked ? 'state-blocked' : ''}`}>{vault.label}</span></div><p className="muted small-text">Project memory, project definitions and coordinator notebooks. A new hub restores a project from here when you add it.</p><dl className="vault-facts"><dt>Remote</dt><dd>{vault.remoteLine}</dd><dt>Last sync</dt><dd>{synced ? <span title={synced.title}>{synced.label}</span> : 'Not yet'}</dd>{vault.lastError && <><dt>Last error</dt><dd className="error-text">{vault.lastError}</dd></>}</dl></section>;
}
function PublicMemoryNotice() { return <p className="notice public-memory-notice">This repository is public. Memory committed here is public too.</p>; }
function ContextPanel({ project, close, ...props }: PageProps & { project: Project; close(): void }) {
  const [view, setView] = useState<ReturnType<typeof ContextEditorSchema.parse>>(), [modelId, setModelId] = useState('');
  const [review, setReview] = useState<ReturnType<typeof ContextEditorReviewSchema.parse>['review'] | null>(null);
  const task = useTask(props.onError), pending = useRef<ReturnType<typeof contextEditorAttempt> | null>(null);
  const route = `/api/projects/${project.id}/context/editor`, current = useRef(route); current.current = route;
  const model = view?.projectId === project.id ? contextEditorWithUi(view, { schema: 'context-editor-request-v1', modelId, busy: task.busy, review }) : undefined;
  const policy = model?.policy ?? contextEditorPolicy();
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      let delay = contextEditorPolicy().pollMs;
      try {
        const next = await api(route, ContextEditorSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted && current.current === route) {
          if (next.projectId !== project.id) throw new Error('The context editor belongs to another project.');
          setView(next); delay = next.policy.pollMs;
        }
      } catch (error) { if (!isCancelled(error) && !controller.signal.aborted) props.onError(error); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), delay); }
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [route, props.onError]);
  const act = (intent: Parameters<typeof contextEditorAttempt>[2]) => void task.run(async signal => {
    if (!model) return;
    const attempt = contextEditorAttempt(pending.current, model, intent, `context_${clientId()}`); pending.current = attempt;
    const receipt = await api(attempt.path, ContextEditorReceiptSchema, 'POST', attempt.command, { signal, waitForHub: true });
    const next = contextEditorAccepted(attempt, receipt, { projectId: project.id, deviceId: model.deviceId });
    if (current.current !== route) return;
    setView(next); pending.current = null;
  });
  const proceed = (action: 'apply' | 'cancel' | 'retry' | 'accept-changes') => act({ schema: 'context-editor-intent-v1', kind: 'continue', action });
  const loadReview = () => void task.run(async signal => {
    if (!model?.operation) return;
    const result = await api(model.paths.review, ContextEditorReviewSchema, 'POST', { schema: 'context-editor-review-request-v1', operationId: model.operation.id }, { signal });
    if (result.projectId !== model.projectId || result.deviceId !== model.deviceId || result.review.operationId !== model.operation.id) throw new Error('The context review belongs to another operation.');
    if (current.current === route) setReview(result.review);
  });
  return <Modal title={model?.title ?? `Context · ${project.name}`} close={close}>
    {!model ? <p>{policy.loading}</p> : <>
      <p>{model.intro}</p>{model.noticeRows.map(notice => <p className={notice.tone} key={notice.text}>{notice.text}</p>)}
      {model.operation?.branchChange && <BranchChangeNotice change={model.operation.branchChange} />}
      {model.operation && <section className="context-operation" aria-label={policy.operationLabel}><p role="status">{model.status}</p>
        {!!model.draftFiles.length && <><p className="muted small-text">{policy.draftNotice}</p><div className="context-diff" aria-label={policy.mergeDiffLabel}>{model.draftFiles.map(file => <div key={file.name}><h3>{file.name}</h3><pre className="git-diff"><span className="removal">{file.beforeLines.join('\n')}</span>{'\n'}<span className="addition">{file.afterLines.join('\n')}</span></pre></div>)}</div></>}
        {model.actions.review.visible && <section aria-label={policy.reviewLabel}>{model.activityNotice && <p>{model.activityNotice}</p>}{model.review && <><pre className="git-diff" aria-label={policy.reviewDiffLabel}>{model.review.diff}</pre><p>{policy.reviewNotice}</p></>}
          <div className="actions">{model.actions.accept.visible && <button disabled={!model.actions.accept.enabled} onClick={() => proceed('accept-changes')}>{model.actions.accept.label}</button>}<button className="secondary" disabled={!model.actions.review.enabled} onClick={loadReview}>{model.actions.review.label}</button></div></section>}
        <div className="actions">{model.actions.cancel.visible && <button className="secondary" disabled={!model.actions.cancel.enabled} onClick={() => proceed('cancel')}>{model.actions.cancel.label}</button>}{model.actions.apply.visible && <button disabled={!model.actions.apply.enabled} onClick={() => proceed('apply')}>{model.actions.apply.label}</button>}{model.actions.retry.visible && <button disabled={!model.actions.retry.enabled} onClick={() => proceed('retry')}>{model.actions.retry.label}</button>}</div>
        {model.actions.openWork.visible && <button className="text-button" disabled={!model.actions.openWork.enabled} onClick={() => { close(); props.navigate(model.actions.openWork.path!); }}>{model.actions.openWork.label}</button>}
      </section>}
      {!!model.choices.length && <div className="context-choices">{model.choices.map(choice => <Fragment key={choice.choice}><button className="secondary" disabled={!choice.enabled} onClick={() => act({ schema: 'context-editor-intent-v1', kind: 'choose', choice: choice.choice })}>{choice.label}</button>
        {model.modelVisible && model.modelAfterChoice === choice.choice && <label>{policy.draftModelLabel}<select value={model.fields.modelId} disabled={!model.modelEnabled} onChange={event => setModelId(event.target.value)}><option value="">{policy.defaultModelLabel}</option>{model.models.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>}
      </Fragment>)}</div>}
      <details className="context-files"><summary>{policy.currentFilesLabel}</summary>{model.currentFiles.map(({file,summary}) => <div key={file.name}><h3>{file.name}</h3><p className="muted small-text">{summary}</p>{file.content && <Markdown>{file.content}</Markdown>}</div>)}</details>
    </>}
  </Modal>;
}
function MemoryViewer({
  project,
  isPublic,
  onError,
  close,
}: {
  project: Project;
  isPublic: boolean;
  onError(error: unknown): void;
  close(): void;
}) {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<z.infer<typeof MemoryNoteSchema>[]>();
  const [selected, setSelected] = useState<z.infer<typeof MemoryNoteSchema>>();
  const [shared, setShared] = useState<z.infer<typeof ProjectMemoryViewSchema>>();
  const [settings, setSettings] = useState<z.infer<typeof ProjectWorkSettingsViewSchema>>();
  const [newTitle, setNewTitle] = useState(''), [newBody, setNewBody] = useState('');
  const task = useTask(onError);
  useEffect(() => {
    if (project.memory.mode !== 'hub') return;
    const abort = new AbortController();
    const refresh = () => void Promise.all([api(`/api/projects/${project.id}/memory/shared`, ProjectMemoryViewSchema, 'GET', undefined, { signal: abort.signal }),
      api(`/api/projects/${project.id}/work-settings`, ProjectWorkSettingsViewSchema, 'GET', undefined, { signal: abort.signal })])
      .then(([view, work]) => { setShared(view); setSettings(work); }, error => { if (!abort.signal.aborted) onError(error); });
    refresh(); const timer = setInterval(refresh, 10_000); return () => { clearInterval(timer); abort.abort(); };
  }, [project.id, project.memory.mode, onError]);
  const memoryAction = (operation: string) => void task.run(async () => {
    await api(`/api/projects/${project.id}/memory/shared`, ProjectMemoryResultSchema, 'POST', { operation, requestId: clientId() });
    setShared(await api(`/api/projects/${project.id}/memory/shared`, ProjectMemoryViewSchema));
  });
  const saveMemorySettings = (capture: boolean, dreamMode: 'apply' | 'suggest') => void task.run(async () => {
    if (!settings) return;
    const { schema: _schema, projectId: _id, revision, ...fields } = settings.settings; void _schema; void _id;
    setSettings(await api(`/api/projects/${project.id}/work-settings`, ProjectWorkSettingsViewSchema, 'PUT', { schema: 'project-work-settings-request-v1', revision,
      clientRequestId: clientId(), settings: { ...fields, memory: { mode: 'hub', capture, dreamMode } } }));
  });
  return (
    <Modal title={`Memory · ${project.name}`} close={close}>
      {isPublic && project.memory.mode !== 'hub' && <PublicMemoryNotice />}
      {project.memory.mode === 'hub' && <section className="memory-shared">
        <p className="muted">Shared by Claude and Codex on every project device. History stays on the hub.</p>
        {settings && <div className="stack"><label className="toggle"><input type="checkbox" checked={settings.settings.memory.capture} disabled={task.busy}
          onChange={event => saveMemorySettings(event.target.checked, settings.settings.memory.dreamMode)} />Capture durable knowledge from sessions</label>
          <label>Nightly dream<select aria-label="Nightly dream" value={settings.settings.memory.dreamMode} disabled={task.busy} onChange={event => saveMemorySettings(settings.settings.memory.capture, event.target.value as 'apply' | 'suggest')}>
            <option value="apply">Apply and tell me</option><option value="suggest">Suggest only</option></select></label></div>}
        <h3>Last night's dream</h3>
        {shared?.notice && shared.notice !== 'Memory dream: not run.' && <p className="muted">{shared.notice}</p>}
        {shared?.dream ? <><p>{shared.dream.state}{shared.dream.reason ? `: ${shared.dream.reason}` : ''}</p>
          {shared.dream.report && <><p>{shared.dream.report.summary}</p><p className="muted">{Object.entries(shared.dream.report.counts).map(([name, count]) => `${name}: ${count}`).join(' · ')}</p></>}
          {shared.dream.diff && <details><summary>Memory changes</summary><pre className="pw-job-log">{shared.dream.diff}</pre></details>}
          <div className="actions">{shared.dream.state === 'applied' && <button className="secondary small" disabled={task.busy} onClick={() => memoryAction('dream-undo')}>Undo</button>}
            {shared.dream.state === 'suggested' && <><button disabled={task.busy} onClick={() => memoryAction('dream-apply')}>Apply</button><button className="secondary" disabled={task.busy} onClick={() => memoryAction('dream-discard')}>Discard suggestion</button></>}</div>
        </> : <p className="muted">No dream recorded yet.</p>}
        <button className="secondary small" disabled={task.busy || shared?.dream?.state === 'running'} onClick={() => memoryAction('dream-run')}>Run now</button>
        <h3>Inbox (from today)</h3>
        {shared?.inbox.length ? shared.inbox.map(note => <button className="memory-result secondary" key={note.permalink} onClick={() => void task.run(async () => setSelected(await api(`/api/projects/${project.id}/memory?permalink=${encodeURIComponent(note.permalink)}`, MemoryNoteSchema)))}>{note.title}</button>) : <p className="muted">No inbox notes.</p>}
        <h3>Project notes</h3>{shared?.notes.map(note => <button className="memory-result secondary" key={note.permalink} onClick={() => void task.run(async () => setSelected(await api(`/api/projects/${project.id}/memory?permalink=${encodeURIComponent(note.permalink)}`, MemoryNoteSchema)))}>{note.title}</button>)}
        {shared?.truncated && <p className="muted">More notes are available through Search memory.</p>}
        <details><summary>Add an owner note</summary><form className="stack" onSubmit={event => { event.preventDefault(); void task.run(async () => {
          await api(`/api/projects/${project.id}/memory/shared`, ProjectMemoryResultSchema, 'POST', { operation: 'write', requestId: clientId(), input: { title: newTitle, content: newBody } });
          setNewTitle(''); setNewBody(''); setShared(await api(`/api/projects/${project.id}/memory/shared`, ProjectMemoryViewSchema));
        }); }}><label>Title<input required maxLength={300} value={newTitle} onChange={event => setNewTitle(event.target.value)} /></label>
          <label>Note<textarea required maxLength={256000} rows={4} value={newBody} onChange={event => setNewBody(event.target.value)} /></label><button disabled={task.busy}>Save owner note</button></form></details>
      </section>}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            const result = await api(
              `/api/projects/${project.id}/memory?query=${encodeURIComponent(query)}`,
              MemorySearchSchema,
            );
            setNotes(result.notes);
            setSelected(undefined);
          });
        }}
      >
        <label>
          Search memory
          <input required value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button disabled={task.busy}>Search</button>
      </form>
      {notes?.length === 0 && <p className="muted">No matching notes.</p>}
      {notes?.map((note) => (
        <button
          className="memory-result secondary"
          key={note.permalink}
          onClick={() =>
            void task.run(async () =>
              setSelected(
                await api(
                  `/api/projects/${project.id}/memory?permalink=${encodeURIComponent(note.permalink)}`,
                  MemoryNoteSchema,
                ),
              ),
            )
          }
        >
          <span>
            {note.title}
            {note.unresolved ? ' (conflicting versions, unresolved)' : ''}
          </span>
          {note.updatedAt && (
            <time
              className="memory-updated"
              dateTime={note.updatedAt}
              title="File modification time on this device"
            >
              Updated {dateTime(note.updatedAt)}
            </time>
          )}
        </button>
      ))}
      {selected && (
        <section>
          <h3>{selected.title}</h3>
          {selected.updatedAt && (
            <p className="muted small-text">
              Updated{' '}
              <time dateTime={selected.updatedAt} title="File modification time on this device">
                {dateTime(selected.updatedAt)}
              </time>
            </p>
          )}
          <Markdown>{selected.content}</Markdown>
        </section>
      )}
    </Modal>
  );
}
