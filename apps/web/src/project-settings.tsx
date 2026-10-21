import { DeploySettings } from './project-deploy.js';
import { ProjectHealthEditor } from './project-health.js';
import { browserPushId } from './notifications.js';
import { NotificationsViewSchema } from '@jevellan/core/client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { EkoaCodeSetupReceiptSchema, ProjectWorkViewSchema, ProjectEnvSecretSummarySchema, ProjectSettingsEditorSchema, ProjectSettingsEditorSavedSchema,
  type ProjectSettingsEditor, type ProjectSettingsSectionKey, type ProjectConfigurationInfo, type ProjectEnvSecretSummary, type ProjectWorkSettings, type ProjectWorkView } from '@jevellan/core/client';
import { ApiError, api, empty } from './api.js';
import { useSettingsSave, useTask, type PageProps } from './components.js';
import { LandingSettings } from './project-landing-settings.js';
import { ProjectCoordinatorFields } from './project-coordinator-fields.js';
import { ProjectPlacementFields } from './project-placement-fields.js';
import { ProjectEnvironmentFields } from './project-environment-fields.js';
import { updated, useLocalError } from './project-work.js';
import * as copy from './project-work-copy.js';
import { ProjectUsageSection } from './project-usage.js';
import { RoutinePreferences } from './routine-preferences.js';
import { type ProjectRoutineSettingsView } from '@jevellan/core/client';

/** Project settings share one revision and one Save; secret values use the vault-only owner routes. */
export function ProjectSettingsPage(props: PageProps & { id: string; navigation: ReactNode }) {
  const { id, navigate } = props;
  const local = useLocalError(props.onError), task = useTask(local.fail), save = useSettingsSave();
  const [base, setBase] = useState<ProjectWorkSettings>();
  const [draft, setDraft] = useState<ProjectWorkSettings>();
  const [configuration, setConfiguration] = useState<ProjectConfigurationInfo>();
  const [editor, setEditor] = useState<ProjectSettingsEditor>();
  const [landingReady, setLandingReady] = useState(false), [loadEpoch, setLoadEpoch] = useState(0);
  const [coordinatorReady, setCoordinatorReady] = useState(false);
  const [placementReady, setPlacementReady] = useState(false);
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [work, setWork] = useState<ProjectWorkView>();
  const [routines, setRoutines] = useState<ProjectRoutineSettingsView>();
  const [stale, setStale] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretStates, setSecretStates] = useState<Record<string, ProjectEnvSecretSummary>>({});
  const path = `/api/projects/${id}/config/editor`;
  const read = useCallback(async (signal: AbortSignal) => {
    const next = await api(path, ProjectSettingsEditorSchema, 'GET', undefined, { signal, waitForHub: true }), settings = next.settingsView;
    setEditor(next); setBase(settings.settings); setDraft(settings.settings); setConfiguration(settings.configuration); setWork(next.work); setRoutines(next.routines); setStale(false); setSecretValues({}); setLoadEpoch(value => value + 1);
    setSecretStates(Object.fromEntries(next.secretStates.map(state => [state.name, state]))); local.setError('');
  }, [id, path, local.setError]);
  useEffect(() => {
    const controller = new AbortController(); void read(controller.signal).catch(error => { if (!controller.signal.aborted) local.fail(error); });
    return () => controller.abort();
  }, [read, local.fail]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([browserPushId(), api('/api/notifications/subscriptions', NotificationsViewSchema, 'GET', undefined, { signal: controller.signal })]).then(([id, view]) => {
      if (!controller.signal.aborted) setPushEnabled(Boolean(id && view.subscriptions.some(sub => sub.id === id)));
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  const change = (patch: Partial<ProjectWorkSettings>) => setDraft(value => value && { ...value, ...patch });
  const write = async (request: Record<string, unknown>, signal: AbortSignal) => {
    try {
      const result = await save(editor!.savePath, ProjectSettingsEditorSavedSchema, 'POST', request, signal);
      setBase(result.settingsView.settings); setConfiguration(result.settingsView.configuration); updated(); return result;
    } catch (error) { if (error instanceof ApiError && error.status === 409) setStale(true); throw error; }
  };
  const setStatus = (status: ProjectWorkSettings['status']) => void task.run(async signal => {
    const saved = await write({ schema: 'project-settings-editor-status-v1', base: base!, status }, signal);
    setDraft(value => value && { ...value, ...saved.statusPatch });
  });
  const saveAll = () => void task.run(async signal => {
    const saved = await write({ schema: 'project-settings-editor-save-v1', base: base!, draft: draft!, secretPresence: Object.fromEntries(Object.entries(secretValues).map(([name, value]) => [name, value.length > 0])) }, signal);
    setDraft(saved.settingsView.settings);
    for (const step of saved.secretSteps) {
      const body = step.kind === 'write' ? { ...step.body, value: secretValues[step.name] ?? '' } : step.body;
      const state = await api(step.path, ProjectEnvSecretSummarySchema, step.method, body, { signal, waitForHub: true });
      setSecretStates(states => ({ ...states, [step.name]: state }));
      if (step.kind === 'write') setSecretValues(values => { const next = { ...values }; delete next[step.name]; return next; });
    }
    props.message(saved.savedNotice); navigate(saved.backPath);
  });
  const section = (key: ProjectSettingsSectionKey, children: ReactNode) => <section id={`project-settings-${key}`} className="pw-settings-section" aria-labelledby={`project-settings-title-${key}`}>
    <h2 id={`project-settings-title-${key}`}>{editor!.sections.find(row => row.key === key)!.label}</h2>{children}</section>;
  const controls = editor?.controls;
  const number = (key: keyof NonNullable<ProjectSettingsEditor['controls']>['numbers'] | 'refill', value: number, onChange: (value: number) => void) => {
    const field = key === 'refill' ? { label: copy.REFILL_INTERVAL, ...routines!.routines.refill, step: 1 } : controls!.numbers[key];
    return <label>{field.label}<input type="number" required min={field.min} max={field.max} step={field.step} value={Number.isNaN(value) ? '' : value} onChange={event => onChange(event.target.valueAsNumber)} /></label>;
  };
  return <div className="pw-settings-page">
    <header className="pw-settings-heading">{props.navigation}<div><h1>{copy.PROJECT_SETTINGS}</h1>{work && <p className="muted">{work.project.name}</p>}</div>
      <button type="button" className="text-button" onClick={() => navigate(editor?.backPath ?? `/projects/${id}`)}>{copy.BACK_TO_PROJECT}</button></header>
    {!draft || !base || !work || !routines || !editor ? <p role="status">{copy.LOADING}</p> : !configuration || !controls || !editor.rigging ? <p role="status">Project configuration metadata is unavailable. Reload after the daemon is updated.</p> : <div className="pw-settings-layout">
      <nav aria-label={copy.SETTINGS_SECTIONS}>{editor.sections.map(row => <a key={row.key} href={`#project-settings-${row.key}`}>{row.label}</a>)}</nav>
      <div className="pw-settings-content"><form className="pw-settings" onSubmit={event => { event.preventDefault(); if (landingReady && coordinatorReady && placementReady && environmentReady && !stale) saveAll(); }}>
        <fieldset disabled={task.busy} className="pw-fields">
          {section('general', <>
            <fieldset><legend>{copy.PROJECT_STATUS}</legend><div className="form-actions">{editor.statusOptions.map(option => <button key={option.value} type="button" className="secondary" aria-pressed={base.status === option.value} onClick={() => setStatus(option.value)}>{option.label}</button>)}</div>
              <p className="pw-field-note">{configuration.pauseHelp}</p><p className="pw-field-note">{configuration.archiveHelp}</p></fieldset>
            <ProjectCoordinatorFields key={loadEpoch} projectId={id} revision={base.revision} value={draft.coordinator} change={coordinator => change({ coordinator })} ready={setCoordinatorReady} conflict={() => setStale(true)} fail={local.fail} />
            <button type="button" className="secondary" onClick={() => void task.run(async signal => { await api(`/api/projects/${id}/coordinator/fresh`, ProjectWorkViewSchema, 'POST', empty, { signal, waitForHub: true }); props.message(copy.FRESH_STARTED); })}>{copy.FRESH_COORDINATOR_SETTINGS}</button>
          </>)}
          {section('instructions', <><label>{copy.PROJECT_INSTRUCTIONS}<textarea aria-label={copy.PROJECT_INSTRUCTIONS} rows={8} maxLength={configuration.instructions.maxLength} value={draft.instructions} onChange={event => change({ instructions: event.target.value })} /></label><p className="pw-field-note">{configuration.instructions.help}</p><p className="pw-counter">{draft.instructions.length} / {configuration.instructions.maxLength.toLocaleString('en-US')}</p></>)}
          {section('placement', <ProjectPlacementFields key={loadEpoch} projectId={id} revision={base.revision} change={placement => change({ placement })} ready={setPlacementReady} conflict={() => setStale(true)} fail={local.fail} />)}
          {section('limits', <>
            <fieldset><legend>{copy.START_MODE}</legend>{controls.startModes.map(mode => <label className="checkbox" key={mode.value}><input type="radio" name="start-mode" checked={draft.startMode === mode.value} onChange={() => change({ startMode: mode.value })} />{mode.label}</label>)}</fieldset>
            <div className="form-grid">{number('maxRunningThreads', draft.maxRunningThreads, maxRunningThreads => change({ maxRunningThreads }))}{number('maxRunningPerDevice', draft.maxRunningPerDevice, maxRunningPerDevice => change({ maxRunningPerDevice }))}
              {number('threadTurnCap', draft.threadTurnCap, threadTurnCap => change({ threadTurnCap }))}{number('maxNewThreadsPerDay', draft.maxNewThreadsPerDay, maxNewThreadsPerDay => change({ maxNewThreadsPerDay }))}</div>
            <p className="pw-field-note">{configuration.dailyThreadHelp}</p>
            <div className="form-grid">{controls.devices.map(row => <label key={row.id}>{row.label}<input type="number" min={controls.numbers.perDeviceLimit.min} max={controls.numbers.perDeviceLimit.max} step={controls.numbers.perDeviceLimit.step} placeholder={`${controls.defaultLimitPrefix}${draft.maxRunningPerDevice}`} value={draft.perDeviceLimits[row.id] ?? ''} onChange={event => {
              const perDeviceLimits = { ...draft.perDeviceLimits }; if (event.target.value) perDeviceLimits[row.id] = Number(event.target.value); else delete perDeviceLimits[row.id]; change({ perDeviceLimits });
            }} /></label>)}</div>
            {number('compactAtPercent', draft.compactAtPercent, compactAtPercent => change({ compactAtPercent }))}
            {number('coordinatorHandoffAtPercent', draft.coordinatorHandoffAtPercent, coordinatorHandoffAtPercent => change({ coordinatorHandoffAtPercent }))}
            <label className="checkbox"><input type="checkbox" checked={draft.sessionCheckpoints.enabled} onChange={event => change({ sessionCheckpoints: { ...draft.sessionCheckpoints, enabled: event.target.checked } })} />{copy.CHECKPOINT_LARGE}</label>
            {number('checkpointMinTokens', draft.sessionCheckpoints.checkpointMinTokens, checkpointMinTokens => change({ sessionCheckpoints: { ...draft.sessionCheckpoints, checkpointMinTokens } }))}
          </>)}
          {section('pull-requests', <>
            <LandingSettings key={loadEpoch} value={base} change={change} ready={setLandingReady} onError={local.fail} /><DeploySettings model={routines} value={draft} change={change} />
            {controls.automaticFixes.map(option => <label className="checkbox" key={option.key}><input type="checkbox" checked={draft.prAutoFix[option.key]} onChange={event => change({ prAutoFix: { ...draft.prAutoFix, [option.key]: event.target.checked } })} />{option.label}</label>)}
            {number('maxRounds', draft.prAutoFix.maxRounds, maxRounds => change({ prAutoFix: { ...draft.prAutoFix, maxRounds } }))}
            <label>{copy.RISKY_AREAS}<textarea aria-label={copy.RISKY_AREAS} rows={4} maxLength={controls.riskyAreasMaxLength} value={draft.riskyAreas} onChange={event => change({ riskyAreas: event.target.value })} /></label>
          </>)}
          {section('environment', <>
            <ProjectEnvironmentFields key={loadEpoch} projectId={id} revision={base.revision} change={change} ready={setEnvironmentReady} conflict={() => setStale(true)} fail={local.fail} secretValues={secretValues} secretStates={secretStates} secretValue={(name, value) => setSecretValues(values => ({ ...values, [name]: value }))} />
            <p className="pw-field-note">{editor.rigging.message}</p><a href={editor.rigging.editPath} onClick={event => { event.preventDefault(); navigate(editor.rigging!.editPath); }}>{copy.EDIT_RIGGING}</a>
          </>)}
          {section('routines', <>
            <label className="checkbox"><input type="checkbox" checked={draft.nightlyWindow.enabled} onChange={event => change({ nightlyWindow: { ...draft.nightlyWindow, enabled: event.target.checked } })} />{copy.NIGHTLY_WINDOW}</label>
            <div className="form-grid"><label>{copy.NIGHTLY_TIME}<input type="time" required pattern={routines.routines.timePattern} value={draft.nightlyWindow.time} onChange={event => change({ nightlyWindow: { ...draft.nightlyWindow, time: event.target.value } })} /></label><label>{copy.NIGHTLY_TIMEZONE}<input required maxLength={routines.routines.timezoneMaxLength} value={draft.nightlyWindow.timezone} onChange={event => change({ nightlyWindow: { ...draft.nightlyWindow, timezone: event.target.value } })} /></label></div>
            <label className="checkbox"><input type="checkbox" checked={draft.refill.enabled} onChange={event => change({ refill: { ...draft.refill, enabled: event.target.checked } })} />{copy.REFILL_ENABLED}</label>
            {number('refill', draft.refill.minIntervalMinutes, minIntervalMinutes => change({ refill: { ...draft.refill, minIntervalMinutes } }))}<p className="pw-field-note">{copy.ROUTINES_EDIT_HELP}</p>
          </>)}
          {section('health', <ProjectHealthEditor projectId={id} checks={draft.healthChecks} change={healthChecks => change({ healthChecks })} fail={local.fail} />)}
          {section('notifications', <fieldset><legend>{copy.PROJECT_NOTIFICATIONS}</legend>{(Object.entries(copy.NOTIFICATION_LEVELS) as Array<[ProjectWorkSettings['notifications']['level'], readonly [string, string]]>).map(([level, [label, help]]) => <label className="pw-notification-level" key={level}><span className="checkbox"><input type="radio" name="notification-level" checked={draft.notifications.level === level} onChange={() => change({ notifications: { ...draft.notifications, level } })} />{label}</span>{help && <span className="pw-field-note">{help}</span>}</label>)}<label className="check"><input type="checkbox" checked={draft.notifications.quietHours.enabled} onChange={event => change({ notifications: { ...draft.notifications, quietHours: { ...draft.notifications.quietHours, enabled: event.target.checked } } })} />Quiet hours</label>
            <div className="form-grid"><label>Quiet hours start<input type="time" value={draft.notifications.quietHours.start} onChange={event => change({ notifications: { ...draft.notifications, quietHours: { ...draft.notifications.quietHours, start: event.target.value } } })} /></label><label>Quiet hours end<input type="time" value={draft.notifications.quietHours.end} onChange={event => change({ notifications: { ...draft.notifications, quietHours: { ...draft.notifications.quietHours, end: event.target.value } } })} /></label></div>
            <label>Quiet hours timezone<input value={draft.notifications.quietHours.timezone} onChange={event => change({ notifications: { ...draft.notifications, quietHours: { ...draft.notifications.quietHours, timezone: event.target.value } } })} /></label>
            <p className="pw-field-note">Updates wait until quiet hours end, then arrive as one summary. Urgent production questions arrive immediately.</p><>{!pushEnabled && <p className="pw-field-note">{copy.NOTIFICATION_DEVICE_HELP}</p>}</></fieldset>)}
          {section('usage', <ProjectUsageSection projectId={id} />)}
        </fieldset>
        {local.error && <p role="alert" className="error">{local.error}{stale && <button type="button" className="text-button" disabled={task.busy} onClick={() => void task.run(read)}>{copy.RELOAD}</button>}</p>}
        <div className="form-actions pw-settings-savebar">
          {work.project.name === 'Ekoa Code' && <button type="button" className="secondary" disabled={task.busy || !draft.coordinator.modelId} onClick={() => void task.run(async signal => { await api(`/api/projects/${id}/ekoa-code-setup`, EkoaCodeSetupReceiptSchema, 'POST', { schema: 'ekoa-code-setup-request-v1', modelId: draft.coordinator.modelId, workflowPull: 208 }, { signal, waitForHub: true }); await read(signal); updated(); })}>{copy.APPLY_EKOA_SETUP}</button>}
          <button type="button" className="secondary" onClick={() => navigate(editor.backPath)}>{copy.CANCEL}</button><button type="submit" disabled={task.busy || stale || !landingReady || !coordinatorReady || !placementReady || !environmentReady}>{task.busy ? copy.SAVING : copy.SAVE}</button>
        </div>
      </form><RoutinePreferences model={routines} saved={setRoutines} /></div>
    </div>}
    {local.error && !draft && <p role="alert" className="error">{local.error}</p>}
  </div>;
}
