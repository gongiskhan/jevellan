import { cacheTokens, SESSION_CACHE_UNAVAILABLE, type SessionCacheView } from '@jevellan/core/client';
export { sessionCacheDay as projectDay, cacheHit } from '@jevellan/core/client';

export function SessionCache({ view }: { view?: SessionCacheView | undefined }) {
  if (!view) return <span className="session-cache-metrics">{SESSION_CACHE_UNAVAILABLE}</span>;
  const line = view.line;
  return <span className="session-cache-metrics" aria-label={line.ariaLabel}>{line.prefix} {line.ratio}
    {' · '}{line.coldStarts} {line.coldStartsLabel}{' · '}{cacheTokens(line.coldWriteTokens)} {line.coldWritesLabel}</span>;
}
export function SessionsCache({ view }: { view?: SessionCacheView | undefined }) {
  if (!view) return <p className="muted">{SESSION_CACHE_UNAVAILABLE}</p>;
  const table = view.table;
  return <details className="session-cache-table">
    <summary>{table.summary}</summary>
    {table.rows.length ? <div className="session-cache-scroll"><table>
      <caption>{table.caption}</caption>
      <thead><tr>{table.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{table.rows.map(row => <tr key={row.key}>
        <th scope="row">{row.title}<small>{row.subtitle}</small></th>
        <td>{row.turns}</td><td>{row.ratio}</td><td>{row.coldStarts}</td><td>{cacheTokens(row.coldWriteTokens)}</td><td>{cacheTokens(row.contextTokens)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted">{table.empty}</p>}
  </details>;
}
