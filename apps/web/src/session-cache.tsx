import type { SessionCacheSummary } from '@jevellan/core/client';

export function projectDay(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function cacheHit(row: SessionCacheSummary): string {
  const total = row.cacheReadTokens + row.cacheWriteTokens + row.uncachedInputTokens;
  return row.usageKnown && total > 0 ? `${Math.round(row.cacheReadTokens / total * 100)}%` : 'Unknown';
}
const tokens = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString();

export function SessionCache({ rows = [], sessionKey, timezone }: { rows?: SessionCacheSummary[] | undefined; sessionKey?: string | undefined; timezone: string }) {
  const row = rows.find(item => item.key === sessionKey && item.day === projectDay(timezone));
  return <span className="session-cache-metrics" aria-label="Session cache today">Cache today {row ? cacheHit(row) : 'Unknown'}
    {' · '}{row?.coldStarts ?? 0} cold starts{' · '}{row ? tokens(row.coldWriteTokens) : 'Unknown'} tokens written cold</span>;
}

export function SessionsCache({ rows = [], timezone, titles }: { rows?: SessionCacheSummary[] | undefined; timezone: string; titles: Record<string, string> }) {
  const today = rows.filter(row => row.day === projectDay(timezone));
  return <details className="session-cache-table">
    <summary>Sessions and cache · today</summary>
    {today.length ? <div className="session-cache-scroll"><table>
      <caption>Today in {timezone}</caption>
      <thead><tr><th>Session</th><th>Turns</th><th>Hit ratio</th><th>Cold starts</th><th>Tokens written cold</th><th>Context</th></tr></thead>
      <tbody>{today.map(row => <tr key={row.key}>
        <th scope="row">{titles[row.owner.id] ?? row.owner.kind}<small>{row.runtime} · {row.model} · {row.key.slice(0, 8)}</small></th>
        <td>{row.turns}</td><td>{cacheHit(row)}</td><td>{row.coldStarts}</td><td>{tokens(row.coldWriteTokens)}</td><td>{tokens(row.contextTokens)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted">No session usage recorded today.</p>}
  </details>;
}
