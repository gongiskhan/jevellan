import type { ProjectWorkSettings } from '@jevellan/core/client';

export function LandingSettings({ value, change }: { value: ProjectWorkSettings; change(patch: Partial<ProjectWorkSettings>): void }) {
  return <>
    <label>Delivery<select value={value.delivery} onChange={event => change({ delivery: event.target.value as ProjectWorkSettings['delivery'] })}><option value="land">Land on main</option><option value="pull-request">Pull request</option></select></label>
    <label className="checkbox"><input type="checkbox" checked={value.autoLand} onChange={event => change({ autoLand: event.target.checked })} />Land automatically</label>
    <p className="pw-field-note">Jev chooses the route after the configured checks pass. Existing threads keep their delivery.</p>
    <fieldset><legend>Landing checks</legend>{value.landingChecks.map((check, index) => <fieldset key={index}><legend>Check {index + 1}</legend>
      <label>Name<input required maxLength={80} value={check.name} onChange={event => change({ landingChecks: value.landingChecks.map((row, at) => at === index ? { ...row, name: event.target.value } : row) })} /></label>
      <label>Paths<textarea value={check.paths.join('\n')} onChange={event => change({ landingChecks: value.landingChecks.map((row, at) => at === index ? { ...row, paths: event.target.value.split('\n').filter(Boolean) } : row) })} /></label>
      <p className="pw-field-note">One file or directory per line. Empty runs for every change.</p>
      <label>Command<textarea required maxLength={2000} value={check.command} onChange={event => change({ landingChecks: value.landingChecks.map((row, at) => at === index ? { ...row, command: event.target.value } : row) })} /></label>
      <button type="button" className="secondary small" onClick={() => change({ landingChecks: value.landingChecks.filter((_, at) => at !== index) })}>Remove check</button>
    </fieldset>)}<button type="button" className="secondary small" disabled={value.landingChecks.length >= 30} onClick={() => change({ landingChecks: [...value.landingChecks, { name: '', paths: [], command: '' }] })}>Add landing check</button></fieldset>
    <label>Smoke check<textarea maxLength={2000} value={value.smokeCheck ?? ''} onChange={event => change({ smokeCheck: event.target.value || null })} /></label><p className="pw-field-note">Runs for every landing.</p>
    <label>Keep commits for these paths<textarea value={value.mergeCommitPaths.join('\n')} onChange={event => change({ mergeCommitPaths: event.target.value.split('\n').filter(Boolean) })} /></label><p className="pw-field-note">Changes under these paths land with a merge commit. Other threads land as one squash commit.</p>
  </>;
}
