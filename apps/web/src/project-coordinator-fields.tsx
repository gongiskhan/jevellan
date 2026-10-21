import { useEffect, useRef, useState } from 'react';
import { ProjectCoordinatorEditorFieldsSchema, ProjectCoordinatorEditorSchema, type ProjectCoordinatorEditor, type ProjectCoordinatorEditorFields, type ProjectWorkSettings } from '@jevellan/core/client';
import { ApiError, api } from './api.js';

/** Raw controls use the shared coordinator preview; the parent keeps its one full-page Save. */
export function ProjectCoordinatorFields({ projectId, revision, value, change, ready, conflict, fail }: {
  projectId: string; revision: number; value: ProjectWorkSettings['coordinator']; change(value: ProjectWorkSettings['coordinator']): void;
  ready(value: boolean): void; conflict(): void; fail(error: unknown): void;
}) {
  const path = `/api/projects/${projectId}/coordinator/editor`;
  const [template, setTemplate] = useState<ProjectCoordinatorEditor>(), [editor, setEditor] = useState<ProjectCoordinatorEditor>();
  const [fields, setFields] = useState<ProjectCoordinatorEditorFields>({ modelId: value.modelId ?? '', effort: value.effort, fresh: false });
  const callbacks = useRef({ change, ready, conflict, fail }); callbacks.current = { change, ready, conflict, fail };
  useEffect(() => {
    const controller = new AbortController(); callbacks.current.ready(false);
    void api(path, ProjectCoordinatorEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(setTemplate)
      .catch(error => { if (!controller.signal.aborted) callbacks.current.fail(error); });
    return () => controller.abort();
  }, [path]);
  const body = template ? JSON.stringify({ ...template.request.base, revision, presentation: 'project-settings', fields }) : null;
  const previewPath = template?.request.previewPath;
  useEffect(() => {
    callbacks.current.ready(false); if (!body || !previewPath) return;
    const controller = new AbortController();
    void api(previewPath, ProjectCoordinatorEditorSchema, 'POST', JSON.parse(body), { signal: controller.signal, waitForHub: true }).then(next => {
      if (controller.signal.aborted) return;
      setEditor(next);
      if (next.saveRequest) callbacks.current.change(next.saveRequest.settingsRequest.settings.coordinator);
      callbacks.current.ready(next.apply.enabled);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409) callbacks.current.conflict();
      callbacks.current.fail(error);
    });
    return () => controller.abort();
  }, [body, previewPath]);
  const edit = (patch: Partial<ProjectCoordinatorEditorFields>) => { callbacks.current.ready(false); setFields(current => ({ ...current, ...patch })); };
  return !editor ? <p role="status">Loading coordinator choices…</p> : <>
    <div className="form-grid"><label>Coordinator model<select aria-label="Coordinator model" value={fields.modelId} onChange={event => edit({ modelId: event.target.value })}>
      {editor.models.map(model => <option key={model.value} value={model.value} disabled={model.disabled}>{model.label}</option>)}</select></label>
      <label>Coordinator effort<select aria-label="Coordinator effort" value={fields.effort} onChange={event => edit({ effort: ProjectCoordinatorEditorFieldsSchema.shape.effort.parse(event.target.value) })}>
        {editor.efforts.map(effort => <option key={effort.value} value={effort.value}>{effort.label}</option>)}</select></label></div>
    {editor.effectiveEffort.line && <p className="pw-field-note">{editor.effectiveEffort.line}</p>}
    {editor.apply.refusal && <p role="status">{editor.apply.refusal}</p>}
  </>;
}
