import * as copy from './project-work-copy.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { RiggingApplicationSchema, RiggingSaveSchema, RiggingViewSchema, RiggingEditorReceiptSchema, RIGGING_SECTIONS, riggingScopeChange, riggingManagedPresentation, riggingManagedDirty, riggingManagedSave, riggingManagedSaved, riggingAddDefaults, riggingAddInput, riggingKindPresentation, riggingActionResult, type RiggingEditorView } from '@jevellan/core/client';
import { api, empty, isCancelled } from './api.js';
import { Markdown, Modal, SectionHeading, useSettingsSave, useTask, type PageProps } from './components.js';
import { useRiggingDisk } from './rigging-disk.js';

function ProjectScope({ value, projects, change }: { value: string[]; projects: RiggingEditorView['projects']; change(value: string[]): void }) {
  return <fieldset className="pw-rigging-projects"><legend>{copy.RIGGING_PROJECTS}</legend><label className="toggle"><input type="checkbox" checked={!value.length} onChange={event => change(riggingScopeChange(value,projects,{all:event.target.checked}))} />{copy.RIGGING_ALL_PROJECTS}</label>
    {projects.map(project => <label className="toggle" key={project.id}><input type="checkbox" checked={value.includes(project.id)} onChange={event => change(riggingScopeChange(value,projects,{id:project.id,checked:event.target.checked}))} />{project.name}</label>)}</fieldset>;
}
type View = z.infer<typeof RiggingViewSchema>;
function ItemEditor({ view, editor, props, close }: { view: View; editor: RiggingEditorView; props: PageProps; close(): void }) {
  const [draft, setDraft] = useState({ schema:'rigging-editor-draft-v1' as const, name: view.item.name, content: view.item.content, projects: view.item.projects ?? [] });
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState('Saved');
  const saved = useRef(view);
  const latest = useRef(draft);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const active = useRef(true);
  const save = useSettingsSave();
  const controller = useRef<AbortController | undefined>(undefined);
  const policy = riggingManagedPresentation(view,editor.runtimes);
  const readOnly = !policy.editable;
  latest.current = draft;
  async function flush(): Promise<void> {
    if (
      (!pending.current &&
        !riggingManagedDirty(saved.current,latest.current))
    )
      return;
    if (pending.current) {
      await pending.current;
      if (
        riggingManagedDirty(saved.current,latest.current)
      )
        await flush();
      return;
    }
    const operation = (async () => {
      const abort = new AbortController();
      controller.current = abort;
      try {
        while (
          riggingManagedDirty(saved.current,latest.current)
        ) {
          const current = saved.current;
          const value = { ...latest.current };
          if (active.current) setStatus('Saving…');
          const input = riggingManagedSave(current,value);
          const result = await save(`/hub/rigging/${current.item.id}`,RiggingSaveSchema,'PUT',input,abort.signal);
          const accepted = riggingManagedSaved(current,input,result);
          saved.current = accepted.view;
          if (active.current) setStatus(accepted.status);
        }
        await props.reload(abort.signal);
      } catch (error) {
        if (active.current) setStatus('Not saved');
        if (!isCancelled(error)) props.onError(error);
        throw error;
      } finally {
        if (controller.current === abort) controller.current = undefined;
      }
    })();
    pending.current = operation;
    try {
      await operation;
    } finally {
      if (pending.current === operation) pending.current = undefined;
    }
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!riggingManagedDirty(saved.current,draft))
      return;
    setStatus('Unsaved changes');
    const timer = setTimeout(() => {
      void flushRef.current().catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, readOnly]);
  return (
    <Modal
      title={readOnly ? view.item.name : `Edit ${view.item.name}`}
      close={() => {
        if (pending.current) {
          controller.current?.abort();
          close();
        } else
          void flush()
            .then(close)
            .catch(() => undefined);
      }}
    >
      {readOnly ? (
        <p className="muted">
          {policy.lockReason}
        </p>
      ) : (
        <label>
          Name
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
      )}
      {policy.scopable && <ProjectScope projects={editor.projects} value={draft.projects} change={projects => setDraft({ ...draft, projects })} />}
      <div className="subheading">
        <span className="muted save-status" role="status">
          {readOnly ? 'Read-only' : status}
        </span>
        <button className="text-button" onClick={() => setPreview(!preview)}>
          {preview ? 'Edit' : 'Preview'}
        </button>
      </div>
      {preview || readOnly ? (
        policy.format === 'markdown' ? (
          <Markdown>{draft.content}</Markdown>
        ) : (
          <pre>{draft.content}</pre>
        )
      ) : (
        <label>
          Content
          <textarea
            className="code-editor"
            rows={15}
            value={draft.content}
            spellCheck={false}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        </label>
      )}
      {!readOnly && (
        <p className="muted small-text">
          Edits save automatically.
          {policy.bundleNote && ` ${policy.bundleNote}`}
        </p>
      )}
    </Modal>
  );
}
function AddItem({ fromPackage, editor, props, close }: { fromPackage: boolean; editor: RiggingEditorView; props: PageProps; close(): void }) {
  const save = useSettingsSave();
  const defaults = riggingAddDefaults(editor.runtimes);
  const [name, setName] = useState(defaults.name);
  const [kind, setKind] = useState<(typeof RIGGING_SECTIONS)[number]['kind']>(defaults.kind);
  const [content, setContent] = useState('');
  const [packageRef, setPackageRef] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [runtimes, setRuntimes] = useState<Record<string, boolean>>(
    defaults.runtimes,
  );
  const task = useTask(props.onError);
  return (
    <Modal title={fromPackage ? 'Add from package' : 'Add local item'} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async (signal) => {
            const request = {schema:'rigging-editor-action-v1' as const,deviceId:editor.deviceId,operation:'add' as const,input:riggingAddInput({name,kind,content,runtimes,projects,...(fromPackage?{packageRef}:{})},editor.runtimes)};
            riggingActionResult(request,await save('/api/rigging/actions',RiggingEditorReceiptSchema,'POST',request,signal));
            await props.reload(signal);
            close();
          });
        }}
      >
        <ProjectScope projects={editor.projects} value={projects} change={setProjects} />
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={riggingKindPresentation(kind).maxNameLength}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            {RIGGING_SECTIONS.map(({kind:value,title:label}) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {fromPackage ? (
          <label>
            APM package
            <input
              required
              value={packageRef}
              onChange={(event) => setPackageRef(event.target.value)}
              placeholder="owner/repository"
            />
          </label>
        ) : (
          <label>
            Content
            <textarea
              required
              className="code-editor"
              rows={9}
              value={content}
              spellCheck={false}
              onChange={(event) => setContent(event.target.value)}
              placeholder={
                riggingKindPresentation(kind).placeholder
              }
            />
          </label>
        )}
        <fieldset>
          <legend>Install for</legend>
          {editor.runtimes.map((runtime) => (
            <label className="toggle" key={runtime.id}>
              <input
                type="checkbox"
                checked={runtimes[runtime.id] ?? false}
                disabled={!runtime.supportedKinds.includes(kind)}
                onChange={(event) => setRuntimes({ ...runtimes, [runtime.id]: event.target.checked })}
              />
              {runtime.label}
              {!runtime.supportedKinds.includes(kind) && ' · Not supported'}
            </label>
          ))}
        </fieldset>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={task.busy}>{task.busy ? 'Installing…' : 'Add item'}</button>
        </div>
      </form>
    </Modal>
  );
}
export function RiggingPage(props: PageProps) {
  const save = useSettingsSave();
  const disk = useRiggingDisk(props);
  const [adding, setAdding] = useState<'local' | 'package'>();
  const [editing, setEditing] = useState<View>();
  const task = useTask(props.onError);
  const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>({});
  function toggle(view: View, runtime: string, enabled: boolean) {
    const key = `${view.item.id}/${runtime}`;
    setPendingToggles((previous) => ({ ...previous, [key]: enabled }));
    void task.run(async (signal) => {
      try {
        if(!disk.view) return;
        const request={schema:'rigging-editor-action-v1' as const,operation:'toggle' as const,deviceId:disk.view.deviceId,id:view.item.id,revision:view.revision,captured:view,runtime,enabled};
        riggingActionResult(request,await save('/api/rigging/actions',RiggingEditorReceiptSchema,'POST',request,signal));
        await props.reload(signal);
      } finally {
        setPendingToggles((previous) => {
          const next = { ...previous };
          delete next[key];
          return next;
        });
      }
    });
  }
  const filter = new URLSearchParams(window.location.search).get('runtime') ?? '';
  const editor = disk.view;
  if(!editor) return <p role="status">Loading Rigging…</p>;
  return (
    <>
      <SectionHeading title="Rigging">
        <div className="actions">
          <button className="secondary" onClick={() => setAdding('package')}>
            Add from package
          </button>
          <button onClick={() => setAdding('local')}>Add local item</button>
        </div>
      </SectionHeading>
      <p className="intro">
        Rigging is what your agents carry on every voyage: the skills, tools, hooks and rules Jevellan
        installs into its own Claude Code and Codex homes.
      </p>
      <label className="compact-label">
        Runtime
        <select
          value={filter}
          onChange={(event) =>
            props.navigate(`/settings/rigging${event.target.value ? `?runtime=${event.target.value}` : ''}`)
          }
        >
          <option value="">All runtimes</option>
          {editor.runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id}>
              {runtime.label}
            </option>
          ))}
        </select>
      </label>
      {disk.controls}
      {disk.notices}
      {disk.promotions}
      {editor.delivery.errors.map(account=><p role="alert" className="error" key={account.accountId}>{account.label}: {account.message}</p>)}
      {editor.delivery.canRetry && (
        <button
          className="secondary"
          disabled={task.busy}
          onClick={() =>
            void task.run(async (signal) => {
              await api('/api/rigging/apply', RiggingApplicationSchema, 'POST', empty, {
                signal,
                waitForHub: true,
              });
              await props.reload(signal);
            })
          }
        >
          Retry delivery
        </button>
      )}
      {editor.sections.map(({kind,title,managed,empty:sectionEmpty}) => (
        <section className="card" key={kind}>
          <h2>{title}</h2>
          {managed.map(policy => {const view=policy.view;return (
              <div className="rigging-row" key={view.item.id}>
                <button className="item-name" onClick={() => setEditing(view)}>
                  <strong>{view.item.name}</strong>
                  <span className="muted">
                    {policy.origin} · {policy.stateLabel}
                  </span>
                </button>
                <div className="runtime-toggles">
                  {policy.toggles.map((runtime) =>
                    runtime.supported ? (
                      <label className="toggle" key={runtime.id}>
                        <input
                          type="checkbox"
                          aria-label={`${view.item.name} for ${runtime.label}`}
                          checked={
                            pendingToggles[`${view.item.id}/${runtime.id}`] ??
                            runtime.checked
                          }
                          disabled={runtime.locked || task.busy}
                          onChange={(event) => toggle(view, runtime.id, event.target.checked)}
                        />
                        {runtime.label}
                      </label>
                    ) : (
                      <span className="muted small-text" key={runtime.id}>
                        Not supported by {runtime.label}
                      </span>
                    ),
                  )}
                </div>
              </div>
            );})}
          {disk.rows(kind)}
          {sectionEmpty && (
              <p className="empty-inline">No {title.toLowerCase()} added.</p>
            )}
        </section>
      ))}
      {editing && <ItemEditor editor={editor} view={editing} props={props} close={() => setEditing(undefined)} />}{' '}
      {adding && (
        <AddItem editor={editor} fromPackage={adding === 'package'} props={props} close={() => setAdding(undefined)} />
      )}
      {disk.editor}
    </>
  );
}
