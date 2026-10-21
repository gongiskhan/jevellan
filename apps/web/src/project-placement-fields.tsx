import { useEffect, useRef, useState } from 'react';
import { ProjectPlacementEditorSchema, type ProjectPlacementEditor, type ProjectPlacementEditorFields, type ProjectWorkSettings } from '@jevellan/core/client';
import { ApiError, api } from './api.js';

/** Only raw controls stay local; the engine interprets All, nullable effort and draft validity. */
export function ProjectPlacementFields({ projectId, revision, change, ready, conflict, fail }: {
  projectId: string; revision: number; change(value: ProjectWorkSettings['placement']): void;
  ready(value: boolean): void; conflict(): void; fail(error: unknown): void;
}) {
  const path = `/api/projects/${projectId}/config/placement-editor`;
  const [template, setTemplate] = useState<ProjectPlacementEditor>(), [editor, setEditor] = useState<ProjectPlacementEditor>();
  const [fields, setFields] = useState<ProjectPlacementEditorFields>();
  const callbacks = useRef({ change, ready, conflict, fail }); callbacks.current = { change, ready, conflict, fail };
  useEffect(() => {
    const controller = new AbortController(); callbacks.current.ready(false);
    void api(path, ProjectPlacementEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(next => {
      if (controller.signal.aborted) return;
      setTemplate(next); setFields(next.fields);
    }).catch(error => { if (!controller.signal.aborted) callbacks.current.fail(error); });
    return () => controller.abort();
  }, [path]);
  const body = template && fields ? JSON.stringify({ ...template.request.base, revision, fields }) : null;
  const previewPath = template?.request.previewPath;
  useEffect(() => {
    callbacks.current.ready(false); if (!body || !previewPath) return;
    const controller = new AbortController();
    void api(previewPath, ProjectPlacementEditorSchema, 'POST', JSON.parse(body), { signal: controller.signal, waitForHub: true }).then(next => {
      if (controller.signal.aborted) return;
      setEditor(next); if (next.patch) callbacks.current.change(next.patch); callbacks.current.ready(next.apply.enabled);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409) callbacks.current.conflict();
      callbacks.current.fail(error);
    });
    return () => controller.abort();
  }, [body, previewPath]);
  const edit = (patch: Partial<ProjectPlacementEditorFields>) => { callbacks.current.ready(false); setFields(current => current && { ...current, ...patch }); };
  return !editor || !fields ? <p role="status">Loading placement choices…</p> : <>
    <fieldset><legend>{editor.modelsLabel}</legend><label className="checkbox"><input type="checkbox" checked={fields.allModels}
      onChange={event => edit({ allModels: event.target.checked, ...(event.target.checked ? {} : { modelIds: editor.restrictedModelIds }) })} />{editor.allModelsLabel}</label>
      {!fields.allModels && editor.models.map(model => <label key={model.id} className="checkbox"><input type="checkbox" checked={fields.modelIds.includes(model.id)}
        onChange={event => edit({ modelIds: event.target.checked ? [...fields.modelIds, model.id] : fields.modelIds.filter(id => id !== model.id) })} />{model.label}</label>)}</fieldset>
    <label>{editor.effortLabel}<select aria-label={editor.effortLabel} value={fields.minEffort} onChange={event => edit({ minEffort: event.target.value })}>
      {editor.efforts.map(effort => <option key={effort.value} value={effort.value}>{effort.label}</option>)}</select></label>
    <label>{editor.guidance.label}<textarea aria-label={editor.guidance.label} rows={4} maxLength={editor.guidance.maxLength} value={fields.guidance} onChange={event => edit({ guidance: event.target.value })} /></label>
    <p className="pw-field-note">{editor.guidance.help}</p><p className="pw-counter">{fields.guidance.length} / {editor.guidance.maxLength.toLocaleString('en-US')}</p>
    {editor.apply.errors.map((error, index) => <p key={`${error.field}:${index}`} role="status">{error.message}</p>)}
  </>;
}
