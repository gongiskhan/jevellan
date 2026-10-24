import { useEffect, useRef, useState } from 'react';
import { ProjectEnvironmentEditorSchema, type ProjectEnvironmentEditor, type ProjectEnvironmentEditorFields, type ProjectWorkSettings, type ProjectEnvSecretSummary } from '@jevellan/core/client';
import { ApiError, api } from './api.js';
import { dateTime } from './components.js';

/** Passwords are separate raw state and never enter the readonly editor protocol. */
export function ProjectEnvironmentFields({ projectId, revision, purpose = 'work', change, ready, conflict, fail, secretValues, secretStates, secretValue }: {
  projectId: string; revision: number; purpose?: 'work' | 'check'; change(value: Partial<Pick<ProjectWorkSettings, 'setupCommand' | 'environment' | 'checkEnvironment'>>): void;
  ready(value: boolean): void; conflict(): void; fail(error: unknown): void;
  secretValues: Record<string, string>; secretStates: Record<string, ProjectEnvSecretSummary>; secretValue(name: string, value: string): void;
}) {
  const path = `/api/projects/${projectId}/config/environment-editor?purpose=${purpose}`;
  const [template, setTemplate] = useState<ProjectEnvironmentEditor>(), [editor, setEditor] = useState<ProjectEnvironmentEditor>();
  const [fields, setFields] = useState<ProjectEnvironmentEditorFields>();
  const callbacks = useRef({ change, ready, conflict, fail }); callbacks.current = { change, ready, conflict, fail };
  useEffect(() => {
    const controller = new AbortController(); callbacks.current.ready(false);
    void api(path, ProjectEnvironmentEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(next => {
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
    void api(previewPath, ProjectEnvironmentEditorSchema, 'POST', JSON.parse(body), { signal: controller.signal, waitForHub: true }).then(next => {
      if (controller.signal.aborted) return;
      setEditor(next); if (next.patch) callbacks.current.change(next.patch); callbacks.current.ready(next.apply.enabled);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409) callbacks.current.conflict();
      callbacks.current.fail(error);
    });
    return () => controller.abort();
  }, [body, previewPath]);
  const edit = (patch: Partial<ProjectEnvironmentEditorFields>) => { callbacks.current.ready(false); setFields(current => current && { ...current, ...patch }); };
  const confirmed = Boolean(editor && fields && JSON.stringify(editor.fields) === JSON.stringify(fields));
  const labels = editor?.labels;
  const rowLabel = (template: string, index: number) => template.replace('{number}', String(index + 1));
  return !editor || !fields ? <p role="status">Loading environment controls…</p> : !labels ? <p role="status">Environment controls are unavailable. Reload after the daemon is updated.</p> : <fieldset><legend>{labels.title}</legend>
    {labels.enable && <label className="checkbox"><input type="checkbox" checked={Boolean(fields.enabled)} onChange={event => edit({ enabled: event.target.checked })} />{labels.enable}</label>}
    <fieldset disabled={Boolean(labels.enable && !fields.enabled)}>
    {labels.setup && <label>{labels.setup}<input aria-label={labels.setup} maxLength={editor.limits.setupCommand} placeholder={labels.setupPlaceholder} value={fields.setupCommand} onChange={event => edit({ setupCommand: event.target.value })} /></label>}
    <label>{labels.copy}<textarea aria-label={labels.copy} rows={4} value={fields.copyFiles} onChange={event => edit({ copyFiles: event.target.value })} /></label><p className="pw-field-note">{editor.copyHelp}</p>
    <fieldset><legend>{labels.variables}</legend><div className="pw-env-head" aria-hidden="true"><span>{labels.name}</span><span>{labels.value}</span></div>
      {fields.variables.map((variable, index) => <div className="pw-env-row" key={index}><input aria-label={rowLabel(labels.variableName, index)} value={variable.name} maxLength={editor.limits.name} onChange={event => edit({ variables: fields.variables.map((row, at) => at === index ? { ...row, name: event.target.value } : row) })} />
        <input aria-label={rowLabel(labels.variableValue, index)} value={variable.value} maxLength={editor.limits.value} onChange={event => edit({ variables: fields.variables.map((row, at) => at === index ? { ...row, value: event.target.value } : row) })} />
        <button type="button" className="text-button" aria-label={rowLabel(labels.removeVariable, index)} onClick={() => edit({ variables: fields.variables.filter((_, at) => at !== index) })}>{labels.remove}</button></div>)}
      <button type="button" className="secondary" disabled={!confirmed || !editor.canAddVariable} onClick={() => edit({ variables: [...fields.variables, editor.newVariable] })}>{labels.addVariable}</button></fieldset>
    <fieldset><legend>{labels.secrets}</legend>{fields.secrets.map((name, index) => {
      const state = secretStates[name], presentation = state ? state.presentation ?? editor.unavailableStatus : editor.notSetStatus;
      return <div className="pw-secret-row" key={index}><div className="pw-env-row"><input aria-label={rowLabel(labels.secretName, index)} value={name} maxLength={editor.limits.name} onChange={event => edit({ secrets: fields.secrets.map((row, at) => at === index ? event.target.value : row) })} />
        <input type="password" autoComplete="new-password" aria-label={rowLabel(labels.secretValue, index)} value={secretValues[name] ?? ''} onChange={event => secretValue(name, event.target.value)} />
        <button type="button" className="text-button" aria-label={rowLabel(labels.removeSecret, index)} onClick={() => edit({ secrets: fields.secrets.filter((_, at) => at !== index) })}>{labels.remove}</button></div>
        <p className="pw-field-note">{presentation.parts.map((part, at) => <span key={at}>{part.kind === 'time' ? dateTime(part.at) : part.text}</span>)}</p></div>;
    })}<button type="button" className="secondary" disabled={!confirmed || !editor.canAddSecret} onClick={() => edit({ secrets: [...fields.secrets, editor.newSecret] })}>{labels.addSecret}</button><p className="pw-field-note">{editor.secretHelp}</p></fieldset>
    </fieldset>
    {editor.apply.errors.map((error, index) => <p key={`${error.field}:${index}`} role="status">{error.message}</p>)}
  </fieldset>;
}
