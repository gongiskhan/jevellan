import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ProjectDefinitionEditorSchema, ProjectFoldersSchema, ProjectViewSchema, projectDefinitionCommand, projectDefinitionDeviceRows, type ProjectDefinitionEditor, type ProjectDefinitionFields, type ProjectDefinitionCommand, type VaultView } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { Modal, useSettingsSave, useTask, type PageProps } from './components.js';
type ProjectView = z.infer<typeof ProjectViewSchema>;
export function ProjectForm(props: PageProps & { row: ProjectView | undefined; vault?: VaultView | undefined; knownPublic: boolean; close(): void; saved(signal: AbortSignal): Promise<void> }) {
  const [view, setView] = useState<ProjectDefinitionEditor>(), [fields, setFields] = useState<ProjectDefinitionFields>();
  const [folders, setFolders] = useState<z.infer<typeof ProjectFoldersSchema>>(), [confirmed, setConfirmed] = useState('');
  const generation = useRef(0), save = useSettingsSave(), task = useTask(props.onError);
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/projects/editor${props.row ? `?projectId=${encodeURIComponent(props.row.project.id)}` : ''}`, ProjectDefinitionEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(next => { if (!controller.signal.aborted) { setView(next); setFields(next.fields); } }).catch(error => { if (!isCancelled(error)) props.onError(error); });
    return () => { controller.abort(); };
  }, [props.row?.project.id]);
  const signature = view && fields ? JSON.stringify({ context: view.context, fields }) : '';
  useEffect(() => {
    if (!view || !fields) return;
    const controller = new AbortController(), requestGeneration = ++generation.current;
    const body = { schema: 'project-definition-preview-v1', context: view.context, fields };
    setConfirmed('');
    void api('/api/projects/editor/preview', ProjectDefinitionEditorSchema, 'POST', body, { signal: controller.signal, waitForHub: true }).then(next => {
      if (!controller.signal.aborted && requestGeneration === generation.current) { setView(next); setConfirmed(signature); }
    }).catch(error => { if (!isCancelled(error) && requestGeneration === generation.current) props.onError(error); });
    return () => { controller.abort(); };
  }, [signature]);
  const change = (patch: Partial<ProjectDefinitionFields>) => { setConfirmed(''); setFields(current => current && { ...current, ...patch }); };
  const command = (input: ProjectDefinitionCommand) => { setConfirmed(''); setFields(current => current && view ? projectDefinitionCommand(current, input, view.devices.map(device => device.id), view.currentDeviceId) : current); };
  const devices = fields && view ? projectDefinitionDeviceRows(fields, view.devices, view.currentDeviceId) : [];
  const browse = (path?: string) => task.run(async signal => {
    const result = await api(`/api/project-folders${path ? `?path=${encodeURIComponent(path)}` : ''}`, ProjectFoldersSchema, 'GET', undefined, { signal });
    setFolders(result); if (path && view) command({ type: 'path', deviceId: view.currentDeviceId, value: result.path });
  });
  return <Modal title={view?.title ?? 'Project'} close={props.close}>
    {!view || !fields ? <p role="status">Loading project…</p> : <form onSubmit={event => {
      event.preventDefault(); if (!view.canSave || confirmed !== signature) return;
      void task.run(async signal => {
        await save('/hub/projects', ProjectViewSchema, 'PUT', { schema: 'project-definition-save-v1', context: view.context, fields }, signal);
        await props.saved(signal);
      });
    }}>
      <label>Name<input value={fields.name} placeholder="The folder name" disabled={task.busy} onChange={event => command({ type: 'name', value: event.target.value })} /></label>
      <label>Remote URL<input value={fields.remoteUrl} placeholder="Optional" disabled={task.busy} onChange={event => change({ remoteUrl: event.target.value })} /></label>
      {view.restorable && <><label className="toggle"><input type="checkbox" checked={fields.restore} disabled={task.busy} onChange={event => change({ restore: event.target.checked })} />Restore from the vault</label><p className="muted small-text">{view.restoreText}</p></>}
      <label className="toggle"><input type="checkbox" checked={fields.requireProjectToken} disabled={task.busy} onChange={event => command({ type: 'github-token', checked: event.target.checked })} />Require this project's GitHub token</label>
      <p className="muted small-text">Save it in Settings → Git. When required, this project waits for its own token.</p>
      {devices.map(device => <label key={device.id}>Path on {device.name}<input required={device.required} disabled={task.busy} placeholder="/absolute/path/to/project" value={fields.paths[device.id] ?? ''} onChange={event => command({ type: 'path', deviceId: device.id, value: event.target.value })} /></label>)}
      <button type="button" className="secondary" disabled={task.busy} onClick={() => void browse()}>Browse folders on {devices.find(device => device.required)?.name}</button>
      {folders && <section className="folder-picker" aria-label="Project folders">
        <p className="project-path">{folders.path}</p><div className="actions">
          {folders.parent && <button type="button" className="text-button" disabled={task.busy} onClick={() => void browse(folders.parent!)}>↑ Parent folder</button>}
          <button type="button" disabled={task.busy} onClick={() => { command({ type: 'path', deviceId: view.currentDeviceId, value: folders.path }); setFolders(undefined); }}>Use this folder</button>
        </div><div className="folder-list">{folders.folders.length === 0 && <p className="muted small-text">No folders inside this one.</p>}{folders.folders.map(folder => <button type="button" key={folder.path} disabled={task.busy} className="text-button" onClick={() => void browse(folder.path)}>▸ {folder.name}</button>)}</div><p className="muted small-text">Choose an existing Git project on this device.</p>
      </section>}
      <label>Git policy<select value={fields.branchPolicy} disabled={task.busy} onChange={event => command({ type: 'branch-policy', value: event.target.value as ProjectDefinitionFields['branchPolicy'] })}>{view.branchChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
      {view.showMainNotice && <p className="notice small-text">Jevellan automatically switches clean checkouts to main and announces the change. If main does not exist, it creates it from published branch history. The original branch is preserved.</p>}
      <label>Test command<input value={fields.testCommand} placeholder="npm test" disabled={task.busy} onChange={event => change({ testCommand: event.target.value })} /></label>
      <fieldset><legend>Allowed devices</legend>{devices.map(device => <label className="toggle" key={device.id}><input type="checkbox" checked={device.checked} disabled={task.busy} onChange={event => command({ type: 'device', deviceId: device.id, checked: event.target.checked })} />{device.name}</label>)}</fieldset>
      {view.showCreateContext && <label className="toggle"><input type="checkbox" checked={fields.createContext} disabled={task.busy} onChange={event => change({ createContext: event.target.checked })} />Create AGENTS.md if no instruction file exists</label>}
      <h3>Memory</h3>{view.publicMemoryNotice && <p className="notice public-memory-notice">This repository is public. Memory committed here is public too.</p>}
      <label>Keep project memory<select value={fields.memory.mode} disabled={task.busy} onChange={event => change({ memory: { ...fields.memory, mode: event.target.value as ProjectDefinitionFields['memory']['mode'] } })}>{view.memoryChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
      {view.showMemoryDirectory ? <label>Memory folder<input required disabled={task.busy} value={fields.memory.dir} onChange={event => change({ memory: { ...fields.memory, dir: event.target.value } })} /></label> : <p className="muted">Notes and their private history stay on the hub. Switching copies the current notes once and keeps the old folder.</p>}
      {view.validation.length > 0 && <p className="error">{view.validation.join(' ')}</p>}
      <div className="form-actions"><button type="button" className="secondary" onClick={props.close}>Cancel</button><button disabled={task.busy || !view.canSave || confirmed !== signature}>{task.busy ? 'Saving…' : 'Save project'}</button></div>
    </form>}
  </Modal>;
}
