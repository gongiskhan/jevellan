import { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectCoordinatorEditorSchema, ProjectWorkSettingsViewSchema, type ProjectCoordinatorEditor, type ProjectCoordinatorEditorFields, type ProjectWorkView } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal, useTask, type PageProps } from './components.js';
import { afterDialogs, updated, useLocalError } from './project-work.js';

export function CoordinatorOverrideDialog({ props, view, close }: { props: PageProps; view: ProjectWorkView; close(): void }) {
  const { error, setError, fail } = useLocalError(props.onError), task = useTask(fail);
  const [editor, setEditor] = useState<ProjectCoordinatorEditor>(), [fields, setFields] = useState<ProjectCoordinatorEditorFields>();
  const pending = useRef<ProjectCoordinatorEditor['saveRequest']>(null), path = `/api/projects/${view.project.id}/coordinator/editor`;
  const read = useCallback(async (signal: AbortSignal) => {
    const next = await api(path, ProjectCoordinatorEditorSchema, 'GET', undefined, { signal, waitForHub: true });
    setEditor(next); setFields(next.fields); pending.current = null; setError('');
  }, [path, setError]);
  useEffect(() => { const controller = new AbortController(); void read(controller.signal).catch(fail); return () => controller.abort(); }, [read, fail]);
  const change = (patch: Partial<ProjectCoordinatorEditorFields>) => {
    if (!editor || !fields) return;
    const next = { ...fields, ...patch };
    void task.run(async signal => {
      setFields(next); pending.current = null; setError('');
      try {
        const result = await api(editor.request.previewPath, ProjectCoordinatorEditorSchema, 'POST', { ...editor.request.base, fields: next }, { signal, waitForHub: true });
        setEditor(result); setFields(result.fields);
      } catch (reason) { setFields(editor.fields); throw reason; }
    });
  };
  const confirmed = Boolean(editor && fields && JSON.stringify(editor.fields) === JSON.stringify(fields));
  return <Modal title="Override coordinator" close={close}>
    <form className="pw-settings" onSubmit={event => { event.preventDefault(); if (!editor?.saveRequest || !confirmed) return;
      void task.run(async signal => {
        setError(''); const request = pending.current ?? editor.saveRequest!; pending.current = request;
        await api(editor.request.savePath, ProjectWorkSettingsViewSchema, 'POST', request, { signal });
        pending.current = null; updated(); afterDialogs(props.message, editor.savedNotice); close();
      });
    }}>
      {!editor || !fields ? <p role="status">Loading…</p> : <fieldset className="pw-fields" disabled={task.busy}>
        <p>{editor.help}</p>
        <div className="form-grid">
          <label>Model<select value={fields.modelId} onChange={event => change({ modelId: event.target.value })}>
            {editor.models.map(model => <option key={model.value} value={model.value} disabled={model.disabled}>{model.label}</option>)}
          </select></label>
          <label>Effort<select value={fields.effort} onChange={event => change({ effort: ProjectCoordinatorEditorSchema.shape.fields.shape.effort.parse(event.target.value) })}>
            {editor.efforts.map(effort => <option key={effort.value} value={effort.value}>{effort.label}</option>)}
          </select></label>
        </div>
        {editor.effectiveEffort.line && <p className="pw-field-note">{editor.effectiveEffort.line}</p>}
        <label className="checkbox"><input type="checkbox" checked={fields.fresh} disabled={!editor.freshEnabled} onChange={event => change({ fresh: event.target.checked })} />Start a fresh session on the next turn</label>
        <p className="pw-field-note">{editor.sessionHelp}</p>
        {editor.apply.refusal && <p role="status">{editor.apply.refusal}</p>}
      </fieldset>}
      {error && <><p className="error" role="alert">{error}</p><button type="button" className="secondary" disabled={task.busy} onClick={() => void task.run(read)}>Reload choices</button></>}
      <div className="actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button disabled={task.busy || !confirmed || !editor?.apply.enabled}>Apply</button></div>
    </form>
  </Modal>;
}
