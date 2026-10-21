import { useEffect, useState } from 'react';
import { ProjectUsageViewSchema, PROJECT_USAGE_REFRESH_MS, type ProjectUsageView } from '@jevellan/core/client';
import { api } from './api.js';
type Range = ProjectUsageView['range'];
type Presentation = NonNullable<ProjectUsageView['presentation']>;
const number = (value: number, format: string) => format === 'usd' ? `$${value.toFixed(2)}` : format === 'count' ? value.toLocaleString() : String(value);
/** Range responses are scoped to this render; an older request cannot replace the selected range. */
export function ProjectUsageSection({ projectId }: { projectId: string }) {
  const [range, setRange] = useState<Range>(), [view, setView] = useState<ProjectUsageView>(), [error, setError] = useState('');
  const [controls, setControls] = useState<{ projectId: string; ranges: Presentation['ranges'] }>();
  useEffect(() => {
    let current = true, generation = 0; const controller = new AbortController(); setView(undefined); setError('');
    const load = () => { const request = ++generation; void api(`/api/projects/${projectId}/usage${range ? `?range=${range}` : ''}`, ProjectUsageViewSchema, 'GET', undefined, { signal: controller.signal })
      .then(result => { if (current && request === generation) { setView(result); setControls(result.presentation ? { projectId, ranges: result.presentation.ranges } : undefined); setError(''); } }, error => { if (current && request === generation) setError(error instanceof Error ? error.message : String(error)); }); };
    load(); const timer = setInterval(load, PROJECT_USAGE_REFRESH_MS);
    return () => { current = false; clearInterval(timer); controller.abort(); };
  }, [projectId, range]);
  const presentation = view?.projectId === projectId ? view.presentation : undefined;
  return <div className="pw-usage">
    <div className="actions">{controls?.projectId === projectId && controls.ranges.map(({ value, label }) => <button type="button" className="secondary" key={value} aria-pressed={(range ?? view?.range) === value} onClick={() => setRange(value)}>{label}</button>)}</div>
    {error && <p className="notice" role="status">{error}</p>}
    {view && !presentation && <p className="notice" role="status">Usage presentation is unavailable. Reload and try again.</p>}
    {presentation?.empty && <p className="muted">{presentation.emptyMessage}</p>}
    {presentation && !presentation.empty && <>
      <dl className="pw-usage-totals">{presentation.totals.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{number(row.value, row.format)}</dd></div>)}</dl>
      {presentation.unknownCostNotice && <p className="muted">{presentation.unknownCostNotice}</p>}
      {presentation.tables.map(table => <div key={table.key}><h3>{table.label}</h3><div className="pw-usage-table"><table><thead><tr>{table.columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{table.rows.map(row => <tr key={row.id}>{table.columns.map(column => { const value = row[column.key]; return column.key === 'label' ? <th key={column.key}>{value}</th> : <td key={column.key}>{typeof value === 'number' ? number(value, column.format) : value}</td>; })}</tr>)}</tbody></table></div></div>)}
    </>}
  </div>;
}
