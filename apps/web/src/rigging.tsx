import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { RiggingApplicationSchema, RiggingSaveSchema, RiggingViewSchema } from '@jevellan/core/client';
import { api, empty, isCancelled } from './api.js';
import { Markdown, Modal, SectionHeading, useSettingsSave, useTask, type PageProps } from './components.js';
import { useRiggingDisk } from './rigging-disk.js';

type View = z.infer<typeof RiggingViewSchema>;
const sections = { skill: 'Skills', mcp: 'MCP servers', hook: 'Hooks', rule: 'Rules', command: 'Commands', setting: 'Settings' };
function ItemEditor({ view, props, close }: { view: View; props: PageProps; close(): void }) {
  const [draft, setDraft] = useState({ name: view.item.name, content: view.item.content }); const [preview, setPreview] = useState(false); const [status, setStatus] = useState('Saved');
  const saved = useRef(view); const latest = useRef(draft); const pending = useRef<Promise<void> | undefined>(undefined); const active = useRef(true);
  const save = useSettingsSave(); const controller = useRef<AbortController | undefined>(undefined);
  const readOnly = view.item.builtIn || Boolean(view.item.packageRef);
  latest.current = draft;
  async function flush(): Promise<void> {
    if (readOnly || (!pending.current && latest.current.name === saved.current.item.name && latest.current.content === saved.current.item.content)) return;
    if (pending.current) { await pending.current; if (latest.current.name !== saved.current.item.name || latest.current.content !== saved.current.item.content) await flush(); return; }
    const operation = (async () => {
      const abort = new AbortController(); controller.current = abort;
      try {
        while (latest.current.name !== saved.current.item.name || latest.current.content !== saved.current.item.content) {
          const current = saved.current; const value = { ...latest.current }; if (active.current) setStatus('Saving…');
          const result = await save(`/hub/rigging/${current.item.id}`, RiggingSaveSchema, 'PUT', { schema: 'update-rigging-v1', revision: current.revision, name: value.name, content: value.content, runtimes: current.item.runtimes, state: current.item.state }, abort.signal);
          if (result.item.item.name !== value.name || result.item.item.content !== value.content) throw new Error('This item changed after your save. Reopen it before editing again.');
          saved.current = result.item;
          if (active.current) setStatus(result.application.accounts.some((account) => account.error) ? 'Saved · delivery needs attention' : 'Saved');
        }
        await props.reload(abort.signal);
      } catch (error) { if (active.current) setStatus('Not saved'); if (!isCancelled(error)) props.onError(error); throw error; }
      finally { if (controller.current === abort) controller.current = undefined; }
    })();
    pending.current = operation;
    try { await operation; } finally { if (pending.current === operation) pending.current = undefined; }
  }
  const flushRef = useRef(flush); flushRef.current = flush;
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (readOnly || (draft.name === saved.current.item.name && draft.content === saved.current.item.content)) return;
    setStatus('Unsaved changes');
    const timer = setTimeout(() => { void flushRef.current().catch(() => undefined); }, 600);
    return () => clearTimeout(timer);
  }, [draft, readOnly]);
  return <Modal title={readOnly ? view.item.name : 'Edit local item'} close={() => { if (pending.current) { controller.current?.abort(); close(); } else void flush().then(close).catch(() => undefined); }}>
    {readOnly ? <p className="muted">{view.item.builtIn ? view.item.id === 'builtin_safety' ? 'Built in · always on' : 'Built in · choose its runtimes with the toggles' : `Package · ${view.item.packageRef}`}</p> : <label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>}
    <div className="subheading"><span className="muted" role="status">{readOnly ? 'Read-only' : status}</span><button className="text-button" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button></div>
    {preview || readOnly ? ['skill', 'rule', 'command'].includes(view.item.kind) ? <Markdown>{draft.content}</Markdown> : <pre>{draft.content}</pre> : <label>Content<textarea className="code-editor" rows={15} value={draft.content} spellCheck={false} onChange={(event) => setDraft({ ...draft, content: event.target.value })}/></label>}
    {!readOnly && <p className="muted small-text">Local edits save automatically.{view.item.bundle && ` ${view.item.bundle.fileCount} bundled ${view.item.bundle.fileCount === 1 ? 'file is' : 'files are'} retained when these instructions change.`}</p>}
  </Modal>;
}
function AddItem({ fromPackage, props, close }: { fromPackage: boolean; props: PageProps; close(): void }) {
  const save = useSettingsSave();
  const [name, setName] = useState(''); const [kind, setKind] = useState<keyof typeof sections>('skill'); const [content, setContent] = useState(''); const [packageRef, setPackageRef] = useState(''); const [runtimes, setRuntimes] = useState<Record<string, boolean>>(Object.fromEntries(props.data.runtimes.map((runtime) => [runtime.id, true]))); const task = useTask(props.onError);
  return <Modal title={fromPackage ? 'Add from package' : 'Add local item'} close={close}><form onSubmit={(event) => { event.preventDefault(); void task.run(async (signal) => { await save('/hub/rigging', RiggingSaveSchema, 'POST', { schema: 'add-rigging-v1', name, kind, content, runtimes, ...(fromPackage ? { packageRef } : {}) }, signal); await props.reload(signal); close(); }); }}>
    <label>Name<input autoFocus required maxLength={128} value={name} onChange={(event) => setName(event.target.value)}/></label><label>Kind<select value={kind} onChange={(event) => setKind(event.target.value as keyof typeof sections)}>{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {fromPackage ? <label>APM package<input required value={packageRef} onChange={(event) => setPackageRef(event.target.value)} placeholder="owner/repository"/></label> : <label>Content<textarea required className="code-editor" rows={9} value={content} spellCheck={false} onChange={(event) => setContent(event.target.value)} placeholder={['hook', 'setting', 'mcp'].includes(kind) ? 'JSON configuration' : 'Instructions in Markdown'}/></label>}
    <fieldset><legend>Install for</legend>{props.data.runtimes.map((runtime) => <label className="toggle" key={runtime.id}><input type="checkbox" checked={runtimes[runtime.id] ?? false} disabled={!runtime.riggingKinds.includes(kind)} onChange={(event) => setRuntimes({ ...runtimes, [runtime.id]: event.target.checked })}/>{runtime.displayName}{!runtime.riggingKinds.includes(kind) && ' · Not supported'}</label>)}</fieldset>
    <div className="form-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button disabled={task.busy}>{task.busy ? 'Installing…' : 'Add item'}</button></div>
  </form></Modal>;
}
export function RiggingPage(props: PageProps) {
  const save = useSettingsSave();
  const disk = useRiggingDisk(props);
  const [adding, setAdding] = useState<'local' | 'package'>(); const [editing, setEditing] = useState<View>(); const task = useTask(props.onError);
  const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>({});
  function toggle(view: View, runtime: string, enabled: boolean) {
    const key = `${view.item.id}/${runtime}`;
    setPendingToggles((previous) => ({ ...previous, [key]: enabled }));
    void task.run(async (signal) => {
      try {
        await save(`/hub/rigging/${view.item.id}`, RiggingSaveSchema, 'PUT', { schema: 'update-rigging-v1', revision: view.revision, name: view.item.name, content: view.item.content, state: enabled ? 'owned' : view.item.state, runtimes: { ...view.item.runtimes, [runtime]: enabled } }, signal);
        await props.reload(signal);
      } finally { setPendingToggles((previous) => { const next = { ...previous }; delete next[key]; return next; }); }
    });
  }
  const filter = new URLSearchParams(window.location.search).get('runtime') ?? '';
  const items = props.data.rigging.items.filter((view) => !filter || Object.hasOwn(view.item.runtimes, filter));
  return <><SectionHeading title="Rigging"><div className="actions"><button className="secondary" onClick={() => setAdding('package')}>Add from package</button><button onClick={() => setAdding('local')}>Add local item</button></div></SectionHeading>
    <p className="intro">Rigging is what your agents carry on every voyage: the skills, tools, hooks and rules Jevellan installs into its own Claude Code and Codex homes.</p>
    <label className="compact-label">Runtime<select value={filter} onChange={(event) => props.navigate(`/settings/rigging${event.target.value ? `?runtime=${event.target.value}` : ''}`)}><option value="">All runtimes</option>{props.data.runtimes.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.displayName}</option>)}</select></label>
    {disk.controls}{disk.notices}{disk.promotions}
    {props.data.rigging.application?.accounts.filter((account) => account.error).map((account) => <p role="alert" className="error" key={account.accountId}>{props.data.accounts.find((view) => view.account.id === account.accountId)?.account.label}: {account.error}</p>)}
    {props.data.rigging.application?.accounts.some((account) => account.error) && <button className="secondary" disabled={task.busy} onClick={() => void task.run(async (signal) => { await api('/api/rigging/apply', RiggingApplicationSchema, 'POST', empty, { signal, waitForHub: true }); await props.reload(signal); })}>Retry delivery</button>}
    {Object.entries(sections).map(([kind, title]) => <section className="card" key={kind}><h2>{title}</h2>{items.filter((view) => view.item.kind === kind).map((view) => <div className="rigging-row" key={view.item.id}>
      <button className="item-name" onClick={() => setEditing(view)}><strong>{view.item.name}</strong><span className="muted">{view.item.builtIn ? 'Built in' : view.item.packageRef ? 'Package' : 'Local'} · {view.item.state === 'owned' ? 'Installed' : view.item.state === 'parked' ? 'Parked' : 'Loose'}</span></button>
      <div className="runtime-toggles">{props.data.runtimes.map((runtime) => runtime.riggingKinds.includes(view.item.kind) ? <label className="toggle" key={runtime.id}><input type="checkbox" aria-label={`${view.item.name} for ${runtime.displayName}`} checked={pendingToggles[`${view.item.id}/${runtime.id}`] ?? view.item.runtimes[runtime.id] ?? false} disabled={view.item.id === 'builtin_safety' || task.busy} onChange={(event) => toggle(view, runtime.id, event.target.checked)}/>{runtime.displayName}</label> : <span className="muted small-text" key={runtime.id}>Not supported by {runtime.displayName}</span>)}</div>
    </div>)}{disk.rows(kind)}{!items.some((view) => view.item.kind === kind) && !disk.items.some((item) => item.kind === kind) && <p className="empty-inline">No {title.toLowerCase()} added.</p>}</section>)}
    {editing && <ItemEditor view={editing} props={props} close={() => setEditing(undefined)}/>} {adding && <AddItem fromPackage={adding === 'package'} props={props} close={() => setAdding(undefined)}/>}{disk.editor}
  </>;
}
