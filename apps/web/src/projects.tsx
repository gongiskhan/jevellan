import { ProjectForm } from './project-definition-editor.js';
export { ProjectForm };
import { ProjectDefinitionsViewSchema, GlobalThreadLimitEditorSchema, ConfigRevisionSchema, type ProjectDefinitionsView } from '@jevellan/core/client';
import { BranchChangeNotice } from './branch-change-notice.js';
import { clientId } from './client-id.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ContextPanelSchema,
  ContextReviewSchema,
  MemoryNoteSchema,
  MemorySearchSchema,
  ProjectMemoryViewSchema, ProjectMemoryResultSchema, ProjectWorkSettingsViewSchema,
  ProjectViewSchema,
  type Project,
} from '@jevellan/core/client';
import { timeStamp } from './time.js';
import { api } from './api.js';
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
  const [review, setReview] = useState<z.infer<typeof ContextReviewSchema>>();
  const [panel, setPanel] = useState<z.infer<typeof ContextPanelSchema>>();
  const [modelId, setModelId] = useState('');
  const task = useTask(props.onError);
  const pending = useRef<{ signature: string; id: string } | undefined>(undefined);
  const route = `/api/projects/${project.id}/context`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api(`${route}/operations`, ContextPanelSchema);
        if (active) setPanel(value);
      } catch (error) {
        if (active) props.onError(error);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [route, props.onError]);
  const send = async (endpoint: string, value: Record<string, unknown>, signal: AbortSignal) => {
    const signature = JSON.stringify(value);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: `context_${clientId()}` };
    setPanel(
      await api(
        `${route}/${endpoint}`,
        ContextPanelSchema,
        'POST',
        { ...value, clientRequestId: pending.current.id },
        { signal, waitForHub: true },
      ),
    );
    pending.current = undefined;
  };
  const operation =
    panel?.operations.find((entry) => !['completed', 'cancelled'].includes(entry.status)) ??
    panel?.operations.at(-1);
  const active = operation && !['completed', 'cancelled'].includes(operation.status);
  const busy = task.busy || panel?.busy;
  const choose = (choice: string) =>
    void task.run((signal) =>
      send(
        'operations',
        {
          schema: 'context-request-v1',
          revision: panel!.revision,
          fingerprint: panel!.context.fingerprint,
          choice,
          ...(choice === 'merge' && modelId ? { modelId } : {}),
        },
        signal,
      ),
    );
  const proceed = (action: string) =>
    void task.run((signal) =>
      send(
        'continue',
        {
          schema: 'context-continue-v1',
          operationId: operation!.id,
          generation: action === 'accept-changes' ? review!.generation : operation!.generation,
          action,
          ...(action === 'accept-changes' ? { fingerprint: review!.fingerprint } : {}),
        },
        signal,
      ),
    );
  const separate = panel?.context.files.every((file) => file.kind === 'file');
  return (
    <Modal title={`Context · ${project.name}`} close={close}>
      {!panel ? (
        <p>Loading context…</p>
      ) : (
        <>
          <p>
            {panel.context.state === 'linked'
              ? `Linked: ${panel.context.files.find((file) => file.kind === 'link')?.name ?? 'Claude Code'} → ${panel.context.primary}`
              : separate
                ? `${project.name} has both AGENTS.md and CLAUDE.md. Agents should read one file.`
                : 'Choose the instructions your agents read in this project.'}
          </p>
          {panel.context.state === 'left-as-is' && (
            <p className="muted">Both files are being kept as they are.</p>
          )}
          {operation?.branchChange && <BranchChangeNotice change={operation.branchChange} />}
          {operation && (
            <section className="context-operation" aria-label="Context operation">
              <p role="status">
                {panel.busy
                  ? operation.status === 'drafting'
                    ? 'Drafting a merge…'
                    : 'Applying and verifying the context change…'
                  : operation.status === 'completed'
                    ? 'Context change completed.'
                    : operation.status === 'cancelled'
                      ? 'Context change cancelled.'
                      : operation.status === 'draft-ready'
                        ? 'Review the proposed changes before applying.'
                        : (operation.reason ?? operation.status)}
              </p>
              {operation.status === 'draft-ready' && operation.draft && (
                <>
                  <p className="muted small-text">
                    The draft ran read-only. Apply replaces AGENTS.md with this text and links CLAUDE.md to
                    it.
                  </p>
                  <div className="context-diff" aria-label="Context merge diff">
                    {operation.before.files.map((file) => (
                      <div key={file.name}>
                        <h3>{file.name}</h3>
                        <pre className="git-diff">
                          <span className="removal">
                            {file.content
                              .split('\n')
                              .map((line) => `− ${line}`)
                              .join('\n')}
                          </span>
                          {'\n'}
                          <span className="addition">
                            {(file.name === 'AGENTS.md' ? operation.draft! : 'Symlink → AGENTS.md')
                              .split('\n')
                              .map((line) => `+ ${line}`)
                              .join('\n')}
                          </span>
                        </pre>
                      </div>
                    ))}
                  </div>
                  <div className="form-actions">
                    <button className="secondary" disabled={busy} onClick={() => proceed('cancel')}>
                      Cancel
                    </button>
                    <button disabled={busy} onClick={() => proceed('apply')}>
                      Apply
                    </button>
                  </div>
                </>
              )}
              {operation.status === 'blocked' && operation.activityReason && (
                <section aria-label="Review context changes">
                  {operation.reason !== operation.activityReason && <p>{operation.activityReason}</p>}
                  {review?.operationId === operation.id && (
                    <>
                      <pre className="git-diff" aria-label="Current context checkout changes">
                        {review.diff}
                      </pre>
                      <p>
                        Continue accepts all the files shown above as this work’s checkpoint, then verifies
                        them before publication.
                      </p>
                    </>
                  )}
                  <div className="actions">
                    {review?.operationId === operation.id && (
                      <button disabled={busy} onClick={() => proceed('accept-changes')}>
                        Continue
                      </button>
                    )}
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void task.run(async () =>
                          setReview(
                            await api(
                              `${route}/review?operation=${encodeURIComponent(operation.id)}`,
                              ContextReviewSchema,
                            ),
                          ),
                        )
                      }
                    >
                      {review?.operationId === operation.id ? 'Refresh changes' : 'Review changes'}
                    </button>
                  </div>
                </section>
              )}
              {operation.status === 'blocked' && !operation.activityReason && (
                <div className="actions">
                  <button disabled={busy} onClick={() => proceed('retry')}>
                    Retry
                  </button>
                  {!operation.applied && (
                    <button className="secondary" disabled={busy} onClick={() => proceed('cancel')}>
                      Cancel
                    </button>
                  )}
                </div>
              )}
              <button
                className="text-button"
                onClick={() => {
                  close();
                  props.navigate(`/conversations/${operation.conversationId}`);
                }}
              >
                Open work
              </button>
            </section>
          )}
          {!active && (
            <>
              {separate ? (
                <div className="context-choices">
                  {project.branchPolicy === 'external' && (
                    <p className="notice">
                      This project follows its own git rules. Only untracked files can become local links.
                    </p>
                  )}
                  <button
                    className="secondary"
                    disabled={busy || (project.branchPolicy === 'external' && panel.context.files[1].tracked)}
                    onClick={() => choose('keep-agents')}
                  >
                    Keep AGENTS.md and link CLAUDE.md to it
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || (project.branchPolicy === 'external' && panel.context.files[0].tracked)}
                    onClick={() => choose('keep-claude')}
                  >
                    Keep CLAUDE.md and link AGENTS.md to it
                  </button>
                  <label>
                    Draft model
                    <select
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      disabled={busy || project.branchPolicy === 'external'}
                    >
                      <option value="">First eligible model</option>
                      {props.data.config.configuration['x-jevellan'].menu
                        .filter((model) => model.enabled)
                        .map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    className="secondary"
                    disabled={busy || project.branchPolicy === 'external'}
                    onClick={() => choose('merge')}
                  >
                    Merge them into AGENTS.md
                  </button>
                  <button className="secondary" disabled={busy} onClick={() => choose('leave')}>
                    Leave both as they are
                  </button>
                </div>
              ) : (
                panel.context.state === 'none' && (
                  <button disabled={busy} onClick={() => choose(panel.context.primary ? 'link' : 'create')}>
                    {panel.context.primary ? 'Link the instruction files' : 'Create AGENTS.md'}
                  </button>
                )
              )}
            </>
          )}
          <details className="context-files">
            <summary>Current instruction files</summary>
            {panel.context.files.map((file) => (
              <div key={file.name}>
                <h3>{file.name}</h3>
                <p className="muted small-text">
                  {file.kind}
                  {file.target ? ` → ${file.target}` : ''}
                  {file.tracked ? ' · tracked' : ''}
                </p>
                {file.content && <Markdown>{file.content}</Markdown>}
              </div>
            ))}
          </details>
        </>
      )}
    </Modal>
  );
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
