import { useEffect, useState } from 'react';
import { ProjectRoutineSettingsViewSchema, type ProjectRoutineSettingsView } from '@jevellan/core/client';
import { ApiError, api } from './api.js';
import { useTask } from './components.js';

/** These preferences have their own canonical revision; saving them leaves the other settings draft intact. */
export function RoutinePreferences({ model, saved }: { model: ProjectRoutineSettingsView; saved(view: ProjectRoutineSettingsView): void }) {
  const [fields, setFields] = useState(model.automation.fields), [error, setError] = useState(''), [stale, setStale] = useState(false), [notice, setNotice] = useState('');
  const task = useTask(error => { setError(error instanceof Error ? error.message : String(error)); if (error instanceof ApiError && error.status === 409) setStale(true); });
  useEffect(() => { setFields(model.automation.fields); setStale(false); setError(''); }, [model.automation]);
  const change = (patch: Partial<typeof fields>) => { setFields(value => ({ ...value, ...patch })); setNotice(''); };
  return <section id="project-settings-automation" className="pw-settings-section" aria-labelledby="project-settings-title-automation">
    <h2 id="project-settings-title-automation">Automation</h2>
    <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
      setError(''); const next = await api(model.automation.request.path, ProjectRoutineSettingsViewSchema, 'POST', { ...model.automation.request.base, fields }, { signal, waitForHub: true });
      saved(next); setNotice('Automation preferences saved.');
    }); }}>
      <fieldset disabled={task.busy}>
        <label className="checkbox"><input type="checkbox" checked={fields.deployPaused} onChange={event => change({ deployPaused: event.target.checked })} />Pause deploys</label>
        <p className="pw-field-note">Pausing keeps the selected deploy mode and the deploy message.</p>
        <label>Landing debounce (minutes)<input type="number" required min={model.automation.constraints.debounceMinutes.min} max={model.automation.constraints.debounceMinutes.max} value={fields.debounceMinutes} onChange={event => change({ debounceMinutes: event.target.value })} /></label>
        <label>Missed-night catch-up (hours)<input type="number" required min={model.automation.constraints.catchUpHours.min} max={model.automation.constraints.catchUpHours.max} value={fields.catchUpHours} onChange={event => change({ catchUpHours: event.target.value })} /></label>
        <p className="pw-field-note">These preferences use their own Save. Other settings edits stay in their form.</p>
        <p>Missed nights in the last seven days: {model.missedNights.length ? model.missedNights.join('; ') : 'none'}</p>
        {error && <p role="alert" className="error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="form-actions"><button type="submit" disabled={stale}>Save automation preferences</button>{stale && <button type="button" className="secondary" onClick={() => void task.run(async signal => saved(await api(model.automation.request.path, ProjectRoutineSettingsViewSchema, 'GET', undefined, { signal, waitForHub: true })))}>Reload automation preferences</button>}</div>
      </fieldset>
    </form>
  </section>;
}
