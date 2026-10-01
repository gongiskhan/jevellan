import { useState } from 'react';

function diffRows(text: string) {
  let before: number | undefined;
  let after: number | undefined;
  return text.split('\n').map(line => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      before = Number(hunk[1]); after = Number(hunk[2]);
      return { line, kind: 'hunk' };
    }
    if (before === undefined || after === undefined || line.startsWith('\\') || !/^[ +-]/.test(line)) return { line, kind: 'meta' };
    if (line.startsWith('+')) return { line, kind: 'addition', after: after++ };
    if (line.startsWith('-')) return { line, kind: 'removal', before: before++ };
    return { line, kind: 'context', before: before++, after: after++ };
  });
}

export function ChangesDiff({ text, label = 'Recorded diff' }: { text: string; label?: string }) {
  const [wrap, setWrap] = useState(false);
  if (!text) return <p className="muted">No checkpoint changes in this step.</p>;
  const sections = text.trimEnd().split(/(?=^diff --git )/m).filter(Boolean).map(part => {
    const rows = diffRows(part);
    const paths = part.split('\n').filter(line => /^(\+\+\+|---) /.test(line)).map(line => line.slice(4)).filter(path => path !== '/dev/null');
    const path = (paths.at(-1) ?? part.split('\n')[0] ?? 'Changes').replace(/^[ab]\//, '');
    return { rows, path, added: rows.filter(row => row.kind === 'addition').length, removed: rows.filter(row => row.kind === 'removal').length };
  });
  return <div className="changes-diff">
    <div className="diff-toolbar"><span className="muted small-text">{label}</span><label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} /> Wrap lines</label></div>
    {sections.map((section, index) => <details className="diff-file" open key={index}>
      <summary><span className="diff-file-path" title={section.path}>{section.path}</span><span className="diff-stats"><span className="added">+{section.added}</span><span className="removed">−{section.removed}</span></span></summary>
      <div className={`diff-scroll${wrap ? ' wrap' : ''}`} tabIndex={0} aria-label={`Diff for ${section.path}`}>
        <div className="diff-lines">{section.rows.map((row, line) => <div className={`diff-line ${row.kind}`} key={line}>
          <span className="diff-line-number" aria-hidden="true">{row.before}</span><span className="diff-line-number" aria-hidden="true">{row.after}</span><code>{row.line || ' '}</code>
        </div>)}</div>
      </div>
    </details>)}
  </div>;
}
