import type { ProjectRouteCorrectionAction, ProjectRouteWhyView } from '@jevellan/core/client';

/** Presentation of an engine-selected route; callers only own panel and request state. */
export function RouteWhyDetails({ view, busy, correct, notice }: { view: ProjectRouteWhyView; busy: boolean; correct(action: ProjectRouteCorrectionAction): void; notice?: string | undefined }) {
  const route = view.route;
  if (!route) return <p>{view.emptyText}</p>;
  return <>
    <p><strong>{route.routeLabel}</strong> · {route.sourceLabel} · {route.stateLabel}</p>
    {route.reason && <p>{route.reason}</p>}
    <p>Checked commit <code>{route.checkedCommit}</code>{route.changeLine && <>. {route.changeLine}</>}</p>
    {route.checks.length > 0 && <ul>{route.checks.map(check => <li key={check.name}>{check.name}: {check.resultLabel}</li>)}</ul>}
    {route.probabilities.length > 0 && <ul>{route.probabilities.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    <p>{route.riskyLine}</p>
    {view.kind === 'landing' && <p>{route.summary}</p>}
    <details><summary>{view.kind === 'landing' ? 'Changed files and corrections' : 'Changed files and context'}</summary>
      {view.kind === 'merge' && <p>{route.summary}</p>}
      <ul>{route.files.map(file => <li key={file.path}>{view.kind === 'merge' ? <code>{file.path}</code> : file.path}{view.kind === 'landing' ? ': ' : ' '}{file.detail}</li>)}</ul>
      {view.kind === 'landing' ? route.corrections.map((line, index) => <p key={index}>{line}</p>) : route.corrections.length > 0 && <ul>{route.corrections.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    </details>
    {view.verifications.map(row => <details key={row.id}><summary>{row.summary}</summary><p>{row.note}</p><ul>{row.commands.map((command, index) => <li key={index}><code>{command}</code></li>)}</ul>{row.failures.map((failure, index) => <div key={index}><p>{failure.what}</p><pre>{failure.output}</pre></div>)}</details>)}
    <div className="pw-pr-actions">{view.correctionActions.map(action => <button key={action.id} type="button" className="secondary" disabled={busy} onClick={() => correct(action)}>{action.label}</button>)}</div>
    {(notice ?? view.savedNotice) && <p role="status">{notice ?? view.savedNotice}</p>}
  </>;
}
