import { useEffect, useState } from 'react';
import { ProjectUsageViewSchema, type ProjectUsageView } from '@jevellan/core/client';
import { api } from './api.js';
import * as copy from './project-work-copy.js';
type Range = ProjectUsageView['range'];
/** Range responses are scoped to this render; an older request cannot replace the selected range. */
export function ProjectUsageSection({ projectId }: { projectId: string }) {
  const [range, setRange] = useState<Range>('today'), [view, setView] = useState<ProjectUsageView>(), [error, setError] = useState('');
  useEffect(() => {
    let current = true, generation = 0; const controller = new AbortController(); setView(undefined); setError('');
    const load = () => { const request = ++generation; void api(`/api/projects/${projectId}/usage?range=${range}`, ProjectUsageViewSchema, 'GET', undefined, { signal: controller.signal })
      .then(result => { if (current && request === generation) { setView(result); setError(''); } }, error => { if (current && request === generation) setError(error instanceof Error ? error.message : String(error)); }); };
    load(); const timer = setInterval(load, 15_000);
    return () => { current = false; clearInterval(timer); controller.abort(); };
  }, [projectId, range]);
  return <div className="pw-usage">
    <div className="actions">{(Object.entries(copy.USAGE_RANGES) as [Range, string][]).map(([value, label]) => <button type="button" className="secondary" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div>
    {error && <p className="notice" role="status">{error}</p>}
    {view && !view.totals.turns && <p className="muted">{copy.USAGE_EMPTY}</p>}
    {view && view.totals.turns > 0 && <>
      <dl className="pw-usage-totals">{(Object.keys(copy.USAGE_TOTALS) as (keyof typeof copy.USAGE_TOTALS)[]).map(key => <div key={key}><dt>{copy.USAGE_TOTALS[key]}</dt><dd>{key === 'costUsd' ? `$${view.totals[key].toFixed(2)}` : view.totals[key].toLocaleString()}</dd></div>)}</dl>
      {view.totals.costUnknownTurns > 0 && <p className="muted">{copy.usageUnknownCost(view.totals.costUnknownTurns)}</p>}
      {(Object.keys(copy.USAGE_TABLES) as (keyof typeof copy.USAGE_TABLES)[]).map(kind => <div key={kind}><h3>{copy.USAGE_TABLES[kind]}</h3><div className="pw-usage-table"><table><thead><tr><th>{copy.USAGE_COLUMNS[kind]}</th>{kind === 'byThread' && <th>{copy.USAGE_COLUMNS.models}</th>}<th>{copy.USAGE_COLUMNS.turns}</th><th>{copy.USAGE_COLUMNS.tokens}</th><th>{copy.USAGE_COLUMNS.cost}</th></tr></thead><tbody>{view[kind].map(row => <tr key={row.id}><th>{kind === 'byKind' ? copy.USAGE_KINDS[row.id as keyof typeof copy.USAGE_KINDS] ?? row.label : row.label}</th>{kind === 'byThread' && <td>{row.models.join(', ')}</td>}<td>{row.turns}</td><td>{(row.inputTokens + row.outputTokens).toLocaleString()}</td><td>${row.costUsd.toFixed(2)}</td></tr>)}</tbody></table></div></div>)}
    </>}
  </div>;
}
