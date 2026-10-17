import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { EkoaCodeSetupReceiptSchema, EffortSchema, EmptySchema, ProjectEnvSecretSummarySchema, ProjectWorkSettingsSchema, ProjectWorkSettingsViewSchema, ProjectWorkViewSchema,
  type ProjectEnvSecretSummary, type ProjectWorkSettings, type ProjectWorkView } from '@jevellan/core/client';
import { ApiError, api, empty } from './api.js';
import { dateTime, useSettingsSave, useTask, type PageProps } from './components.js';
import { mainIsolationBlock } from './project-work-model.js';
import { updated, useLocalError } from './project-work.js';
import * as copy from './project-work-copy.js';
import { ProjectUsageSection } from './project-usage.js';

const sections = [['general', copy.SETTINGS_GENERAL], ['instructions', copy.SETTINGS_INSTRUCTIONS], ['placement', copy.SETTINGS_PLACEMENT],
  ['limits', copy.SETTINGS_LIMITS], ['pull-requests', copy.PULL_REQUESTS], ['environment', copy.SETTINGS_ENVIRONMENT], ['routines', copy.SETTINGS_ROUTINES],
  ['notifications', copy.SETTINGS_NOTIFICATIONS], ['usage', copy.SETTINGS_USAGE]] as const;
const fields = (settings: ProjectWorkSettings) => {
  const { schema: _schema, projectId: _projectId, revision: _revision, ...value } = settings; void _schema; void _projectId; void _revision;
  return value;
};

/** Project settings share one revision and one Save; secret values use the vault-only owner routes. */
export function ProjectSettingsPage(props: PageProps & { id: string; navigation: ReactNode }) {
  const { id, data, navigate } = props;
  const local = useLocalError(props.onError), task = useTask(local.fail), save = useSettingsSave();
  const [base, setBase] = useState<ProjectWorkSettings>();
  const [draft, setDraft] = useState<ProjectWorkSettings>();
  const [work, setWork] = useState<ProjectWorkView>();
  const [stale, setStale] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string>();
  const [isolationChanged, setIsolationChanged] = useState(false);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretStates, setSecretStates] = useState<Record<string, ProjectEnvSecretSummary>>({});
  const path = `/api/projects/${id}/work-settings`, secretPath = (name: string) => `/api/projects/${id}/env-secrets/${encodeURIComponent(name)}`;
  const read = useCallback(async (signal: AbortSignal) => {
    const [settings, view] = await Promise.all([api(path, ProjectWorkSettingsViewSchema, 'GET', undefined, { signal, waitForHub: true }),
      api(`/api/projects/${id}/work`, ProjectWorkViewSchema, 'GET', undefined, { signal, waitForHub: true })]);
    const states = await Promise.all(settings.settings.environment.secrets.map(name => api(`/api/projects/${id}/env-secrets/${encodeURIComponent(name)}`, ProjectEnvSecretSummarySchema, 'GET', undefined, { signal, waitForHub: true })));
    setSettingsNotice(settings.notice); setIsolationChanged(false); setBase(settings.settings); setDraft(settings.settings); setWork(view); setStale(false); setSecretValues({});
    setSecretStates(Object.fromEntries(states.map(state => [state.name, state]))); local.setError('');
  }, [id, path, local.setError]);
  useEffect(() => {
    const controller = new AbortController(); void read(controller.signal).catch(error => { if (!controller.signal.aborted) local.fail(error); });
    return () => controller.abort();
  }, [read, local.fail]);
  const change = (patch: Partial<ProjectWorkSettings>) => setDraft(value => value && { ...value, ...patch });
  const write = async (value: ProjectWorkSettings, signal: AbortSignal, statusOnly = false) => {
    const parsed = ProjectWorkSettingsSchema.safeParse(value);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
    try {
      const result = await save(path, ProjectWorkSettingsViewSchema, 'PUT', { schema: 'project-work-settings-request-v1', revision: base!.revision, settings: { ...fields(parsed.data), defaultIsolation: settingsNotice && (statusOnly || !isolationChanged) ? 'main' : parsed.data.defaultIsolation } }, signal);
      setBase(result.settings); updated(); return result.settings;
    } catch (error) { if (error instanceof ApiError && error.status === 409) setStale(true); throw error; }
  };
  const setStatus = (status: ProjectWorkSettings['status']) => void task.run(async signal => {
    const saved = await write({ ...base!, status }, signal, true);
    setDraft(value => value && { ...value, status, revision: saved.revision });
  });
  const saveAll = () => void task.run(async signal => {
    const previous = base!, saved = await write(draft!, signal); setDraft(saved);
    for (const name of previous.environment.secrets.filter(name => !saved.environment.secrets.includes(name))) {
      await api(secretPath(name), ProjectEnvSecretSummarySchema, 'DELETE', empty, { signal, waitForHub: true });
    }
    for (const name of saved.environment.secrets) {
      const value = secretValues[name]; if (!value) continue;
      const state = await api(secretPath(name), ProjectEnvSecretSummarySchema, 'PUT', { schema: 'save-secret-v1', value }, { signal, waitForHub: true });
      setSecretStates(states => ({ ...states, [name]: state }));
      setSecretValues(values => { const next = { ...values }; delete next[name]; return next; });
    }
    props.message(copy.SETTINGS_SAVED); navigate(`/projects/${id}`);
  });
  const enabledModels = data.config.configuration['x-jevellan'].menu.filter(model => model.enabled);
  const models = data.config.configuration['x-jevellan'].menu.filter(model => model.enabled || model.id === draft?.coordinator.modelId);
  const rigging = data.rigging.items.filter(row => row.item.state === 'owned').map(row => row.item.name);
  const section = (key: typeof sections[number][0], children: ReactNode) => <section id={`project-settings-${key}`} className="pw-settings-section" aria-labelledby={`project-settings-title-${key}`}>
    <h2 id={`project-settings-title-${key}`}>{sections.find(row => row[0] === key)![1]}</h2>{children}</section>;
  const number = (label: string, value: number, min: number, max: number, onChange: (value: number) => void) => <label>{label}<input type="number" required min={min} max={max} step={1} value={Number.isNaN(value) ? '' : value} onChange={event => onChange(event.target.valueAsNumber)} /></label>;
  return <div className="pw-settings-page">
    <header className="pw-settings-heading">{props.navigation}<div><h1>{copy.PROJECT_SETTINGS}</h1>{work && <p className="muted">{work.project.name}</p>}</div>
      <button type="button" className="text-button" onClick={() => navigate(`/projects/${id}`)}>{copy.BACK_TO_PROJECT}</button></header>
    {!draft || !base || !work ? <p role="status">{copy.LOADING}</p> : <div className="pw-settings-layout">
      <nav aria-label={copy.SETTINGS_SECTIONS}>{sections.map(([key, title]) => <a key={key} href={`#project-settings-${key}`}>{title}</a>)}</nav>
      <form className="pw-settings" onSubmit={event => { event.preventDefault(); saveAll(); }}>
        <fieldset disabled={task.busy} className="pw-fields">
          {section('general', <>
            <fieldset><legend>{copy.PROJECT_STATUS}</legend><div className="form-actions">{(['active', 'paused', 'archived'] as const).map(status => <button key={status} type="button" className="secondary" aria-pressed={base.status === status} onClick={() => setStatus(status)}>{copy.PROJECT_STATUS_LABELS[status]}</button>)}</div>
              <p className="pw-field-note">{copy.PROJECT_PAUSE_HELP}</p><p className="pw-field-note">{copy.PROJECT_ARCHIVE_HELP}</p></fieldset>
            <div className="form-grid"><label>{copy.COORDINATOR_MODEL}<select value={draft.coordinator.modelId ?? ''} onChange={event => change({ coordinator: { ...draft.coordinator, modelId: event.target.value || null } })}>
              <option value="">{copy.AUTOMATIC_FIRST_AVAILABLE}</option>{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
              <label>{copy.COORDINATOR_EFFORT}<select value={draft.coordinator.effort} onChange={event => change({ coordinator: { ...draft.coordinator, effort: EffortSchema.parse(event.target.value) } })}>{EffortSchema.options.map(effort => <option key={effort} value={effort}>{copy.EFFORT_LABELS[effort]}</option>)}</select></label></div>
            <button type="button" className="secondary" onClick={() => void task.run(async signal => { await api(`/api/projects/${id}/coordinator/fresh`, EmptySchema, 'POST', empty, { signal, waitForHub: true }); props.message(copy.FRESH_STARTED); })}>{copy.FRESH_COORDINATOR_SETTINGS}</button>
            <fieldset className="pw-isolation"><legend>{copy.DEFAULT_ISOLATION}</legend>
              {(['worktree', 'main'] as const).map(isolation => <label className="checkbox" key={isolation}><input type="radio" name="project-isolation" checked={draft.defaultIsolation === isolation} disabled={isolation === 'main' && !!mainIsolationBlock(work)} aria-describedby={isolation === 'main' && mainIsolationBlock(work) ? 'project-main-note' : undefined} onChange={() => { setIsolationChanged(true); change({ defaultIsolation: isolation }); }} />{isolation === 'worktree' ? copy.WORKTREE_AND_PULL_REQUEST : copy.MAIN}</label>)}
              {mainIsolationBlock(work) && <p id="project-main-note" className="pw-field-note">{mainIsolationBlock(work)}</p>}
              {!mainIsolationBlock(work) && work.project.branchPolicy === 'external' && <p className="pw-field-note">{copy.MANUAL_MAIN_HELP}</p>}
            </fieldset>
            <label className="checkbox"><input type="checkbox" checked={draft.allowMainIsolation} onChange={event => change({ allowMainIsolation: event.target.checked })} />{copy.ALLOW_MAIN}</label>
          </>)}
          {section('instructions', <><label>{copy.PROJECT_INSTRUCTIONS}<textarea aria-label={copy.PROJECT_INSTRUCTIONS} rows={8} maxLength={16000} value={draft.instructions} onChange={event => change({ instructions: event.target.value })} /></label><p className="pw-field-note">{copy.PROJECT_INSTRUCTIONS_HELP}</p><p className="pw-counter">{copy.instructionsCount(draft.instructions.length)}</p></>)}
          {section('placement', <>
            <fieldset><legend>{copy.THREAD_MODELS}</legend><label className="checkbox"><input type="checkbox" checked={draft.placement.allowedModelIds === null} onChange={event => change({ placement: { ...draft.placement, allowedModelIds: event.target.checked ? null : enabledModels.map(model => model.id) } })} />{copy.ALL_ENABLED_MODELS}</label>
              {draft.placement.allowedModelIds !== null && enabledModels.map(model => <label key={model.id} className="checkbox"><input type="checkbox" checked={draft.placement.allowedModelIds!.includes(model.id)} onChange={event => change({ placement: { ...draft.placement, allowedModelIds: event.target.checked ? [...draft.placement.allowedModelIds!, model.id] : draft.placement.allowedModelIds!.filter(id => id !== model.id) } })} />{model.label}</label>)}</fieldset>
            <label>{copy.LOWEST_EFFORT}<select value={draft.placement.minEffort ?? ''} onChange={event => change({ placement: { ...draft.placement, minEffort: event.target.value ? EffortSchema.parse(event.target.value) : null } })}><option value="">{copy.NO_MINIMUM}</option>{EffortSchema.options.map(effort => <option key={effort} value={effort}>{copy.EFFORT_LABELS[effort]}</option>)}</select></label>
            <label>{copy.PLACEMENT_GUIDANCE}<textarea aria-label={copy.PLACEMENT_GUIDANCE} rows={4} maxLength={2000} value={draft.placement.guidance} onChange={event => change({ placement: { ...draft.placement, guidance: event.target.value } })} /></label><p className="pw-field-note">{copy.PLACEMENT_GUIDANCE_HELP}</p><p className="pw-counter">{copy.guidanceCount(draft.placement.guidance.length)}</p>
          </>)}
          {section('limits', <>
            <fieldset><legend>{copy.START_MODE}</legend>{(['start', 'propose'] as const).map(mode => <label className="checkbox" key={mode}><input type="radio" name="start-mode" checked={draft.startMode === mode} onChange={() => change({ startMode: mode })} />{mode === 'start' ? copy.START_RIGHT_AWAY : copy.PROPOSE_FIRST}</label>)}</fieldset>
            <div className="form-grid">{number(copy.MAX_RUNNING_THREADS, draft.maxRunningThreads, 1, 20, maxRunningThreads => change({ maxRunningThreads }))}{number(copy.MAX_PER_DEVICE, draft.maxRunningPerDevice, 1, 10, maxRunningPerDevice => change({ maxRunningPerDevice }))}
              {number(copy.TURN_LIMIT, draft.threadTurnCap, 5, 200, threadTurnCap => change({ threadTurnCap }))}{number(copy.NEW_THREADS_PER_DAY, draft.maxNewThreadsPerDay, 1, 500, maxNewThreadsPerDay => change({ maxNewThreadsPerDay }))}</div>
            <p className="pw-field-note">{copy.NEW_THREADS_PER_DAY_HELP}</p>
            <div className="form-grid">{data.roster.devices.filter(row => !row.revoked && row.device.workPolicy?.mode !== 'apps-only').map(row => <label key={row.device.id}>{copy.deviceLimit(row.device.name)}<input type="number" min={1} max={10} placeholder={copy.deviceDefaultLimit(draft.maxRunningPerDevice)} value={draft.perDeviceLimits[row.device.id] ?? ''} onChange={event => {
              const perDeviceLimits = { ...draft.perDeviceLimits }; if (event.target.value) perDeviceLimits[row.device.id] = Number(event.target.value); else delete perDeviceLimits[row.device.id]; change({ perDeviceLimits });
            }} /></label>)}</div>
            {number(copy.COMPACT_AT_PERCENT, draft.compactAtPercent, 50, 90, compactAtPercent => change({ compactAtPercent }))}
            <label className="checkbox"><input type="checkbox" checked={draft.sessionCheckpoints.enabled} onChange={event => change({ sessionCheckpoints: { ...draft.sessionCheckpoints, enabled: event.target.checked } })} />{copy.CHECKPOINT_LARGE}</label>
            {number(copy.CHECKPOINT_MINIMUM, draft.sessionCheckpoints.checkpointMinTokens, 20000, 200000, checkpointMinTokens => change({ sessionCheckpoints: { ...draft.sessionCheckpoints, checkpointMinTokens } }))}
          </>)}
          {section('pull-requests', <>
            {([['checks', copy.FIX_CHECKS_AUTOMATICALLY], ['conflicts', copy.FIX_CONFLICTS_AUTOMATICALLY], ['comments', copy.FIX_COMMENTS_AUTOMATICALLY]] as const).map(([kind, label]) => <label className="checkbox" key={kind}><input type="checkbox" checked={draft.prAutoFix[kind]} onChange={event => change({ prAutoFix: { ...draft.prAutoFix, [kind]: event.target.checked } })} />{label}</label>)}
            {number(copy.AUTOMATIC_FIX_LIMIT, draft.prAutoFix.maxRounds, 1, 10, maxRounds => change({ prAutoFix: { ...draft.prAutoFix, maxRounds } }))}
            <label className="checkbox"><input type="checkbox" checked={draft.autoMerge} onChange={event => change({ autoMerge: event.target.checked })} />{copy.AUTO_MERGE}</label>
            <label>{copy.REQUIRED_CHECKS}<textarea aria-label={copy.REQUIRED_CHECKS} value={draft.requiredChecks.join('\n')} onChange={event => change({ requiredChecks: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) })} /></label>
            <label>{copy.RISKY_AREAS}<textarea aria-label={copy.RISKY_AREAS} rows={4} maxLength={2000} value={draft.riskyAreas} onChange={event => change({ riskyAreas: event.target.value })} /></label>
          </>)}
          {section('environment', <>
            <label>{copy.SETUP_COMMAND}<input maxLength={500} placeholder={copy.SETUP_COMMAND_PLACEHOLDER} value={draft.setupCommand ?? ''} onChange={event => change({ setupCommand: event.target.value || null })} /></label>
            <label>{copy.COPY_UNTRACKED}<textarea aria-label={copy.COPY_UNTRACKED} rows={4} value={draft.environment.copyFiles.join('\n')} onChange={event => change({ environment: { ...draft.environment, copyFiles: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) } })} /></label><p className="pw-field-note">{copy.COPY_UNTRACKED_HELP}</p>
            <fieldset><legend>{copy.ENV_VARIABLES}</legend><div className="pw-env-head" aria-hidden="true"><span>{copy.ENV_NAME}</span><span>{copy.ENV_VALUE}</span></div>
              {draft.environment.variables.map((variable, index) => <div className="pw-env-row" key={index}><input aria-label={copy.variableName(index)} value={variable.name} maxLength={64} onChange={event => change({ environment: { ...draft.environment, variables: draft.environment.variables.map((row, at) => at === index ? { ...row, name: event.target.value } : row) } })} />
                <input aria-label={copy.variableValue(index)} value={variable.value} maxLength={4000} onChange={event => change({ environment: { ...draft.environment, variables: draft.environment.variables.map((row, at) => at === index ? { ...row, value: event.target.value } : row) } })} />
                <button type="button" className="text-button" aria-label={copy.removeVariable(index)} onClick={() => change({ environment: { ...draft.environment, variables: draft.environment.variables.filter((_, at) => at !== index) } })}>{copy.REMOVE_ENV}</button></div>)}
              <button type="button" className="secondary" disabled={draft.environment.variables.length >= 50} onClick={() => change({ environment: { ...draft.environment, variables: [...draft.environment.variables, { name: '', value: '' }] } })}>{copy.ADD_VARIABLE}</button></fieldset>
            <fieldset><legend>{copy.ENV_SECRETS}</legend>{draft.environment.secrets.map((name, index) => <div className="pw-secret-row" key={index}>
              <div className="pw-env-row"><input aria-label={copy.secretName(index)} value={name} maxLength={64} onChange={event => change({ environment: { ...draft.environment, secrets: draft.environment.secrets.map((row, at) => at === index ? event.target.value : row) } })} />
                <input type="password" autoComplete="new-password" aria-label={copy.secretValue(index)} value={secretValues[name] ?? ''} onChange={event => setSecretValues(values => ({ ...values, [name]: event.target.value }))} />
                <button type="button" className="text-button" aria-label={copy.removeSecret(index)} onClick={() => change({ environment: { ...draft.environment, secrets: draft.environment.secrets.filter((_, at) => at !== index) } })}>{copy.REMOVE_ENV}</button></div>
              <p className="pw-field-note">{secretStates[name]?.saved ? copy.secretSavedAt(dateTime(secretStates[name]!.updatedAt!)) : copy.SECRET_NOT_SET}</p></div>)}
              <button type="button" className="secondary" disabled={draft.environment.secrets.length >= 50} onClick={() => change({ environment: { ...draft.environment, secrets: [...draft.environment.secrets, ''] } })}>{copy.ADD_SECRET}</button><p className="pw-field-note">{copy.SECRET_HELP}</p></fieldset>
            <p className="pw-field-note">{rigging.length ? copy.projectRigging(rigging.join(', ')) : copy.RIGGING_NONE}</p><a href="/settings/rigging" onClick={event => { event.preventDefault(); navigate('/settings/rigging'); }}>{copy.EDIT_RIGGING}</a>
          </>)}
          {section('routines', <>
            <label className="checkbox"><input type="checkbox" checked={draft.nightlyWindow.enabled} onChange={event => change({ nightlyWindow: { ...draft.nightlyWindow, enabled: event.target.checked } })} />{copy.NIGHTLY_WINDOW}</label>
            <div className="form-grid"><label>{copy.NIGHTLY_TIME}<input type="time" required value={draft.nightlyWindow.time} onChange={event => change({ nightlyWindow: { ...draft.nightlyWindow, time: event.target.value } })} /></label><label>{copy.NIGHTLY_TIMEZONE}<input required value={draft.nightlyWindow.timezone} onChange={event => change({ nightlyWindow: { ...draft.nightlyWindow, timezone: event.target.value } })} /></label></div>
            <label className="checkbox"><input type="checkbox" checked={draft.refill.enabled} onChange={event => change({ refill: { ...draft.refill, enabled: event.target.checked } })} />{copy.REFILL_ENABLED}</label>
            {number(copy.REFILL_INTERVAL, draft.refill.minIntervalMinutes, 10, 1440, minIntervalMinutes => change({ refill: { ...draft.refill, minIntervalMinutes } }))}<p className="pw-field-note">{copy.ROUTINES_EDIT_HELP}</p>
          </>)}
          {section('notifications', <fieldset><legend>{copy.PROJECT_NOTIFICATIONS}</legend>{(Object.entries(copy.NOTIFICATION_LEVELS) as Array<[ProjectWorkSettings['notifications'], readonly [string, string]]>).map(([level, [label, help]]) => <label className="pw-notification-level" key={level}><span className="checkbox"><input type="radio" name="notification-level" checked={draft.notifications === level} onChange={() => change({ notifications: level })} />{label}</span>{help && <span className="pw-field-note">{help}</span>}</label>)}<p className="pw-field-note">{copy.NOTIFICATION_DEVICE_HELP}</p></fieldset>)}
          {section('usage', <ProjectUsageSection projectId={id} />)}
        </fieldset>
        {local.error && <p role="alert" className="error">{local.error}{stale && <button type="button" className="text-button" disabled={task.busy} onClick={() => void task.run(read)}>{copy.RELOAD}</button>}</p>}
        <div className="form-actions pw-settings-savebar">
          {work.project.name === 'Ekoa Code' && <button type="button" className="secondary" disabled={task.busy || !draft.coordinator.modelId} onClick={() => void task.run(async signal => { await api(`/api/projects/${id}/ekoa-code-setup`, EkoaCodeSetupReceiptSchema, 'POST', { schema: 'ekoa-code-setup-request-v1', modelId: draft.coordinator.modelId, workflowPull: 208 }, { signal, waitForHub: true }); await read(signal); updated(); })}>{copy.APPLY_EKOA_SETUP}</button>}
          <button type="button" className="secondary" onClick={() => navigate(`/projects/${id}`)}>{copy.CANCEL}</button><button type="submit" disabled={task.busy || stale}>{task.busy ? copy.SAVING : copy.SAVE}</button>
        </div>
      </form>
    </div>}
    {local.error && !draft && <p role="alert" className="error">{local.error}</p>}
  </div>;
}
