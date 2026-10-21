import { changesDiffView, type ChangesDiffView } from '@jevellan/core/client';
import { useState } from 'react';

export function ChangesDiff({ text, label = 'Recorded diff', view: prepared }: { text: string; label?: string; view?: ChangesDiffView | undefined }) {
  const [wrap, setWrap] = useState(false);
  const view = prepared ?? changesDiffView(text);
  if (view.empty) return <p className="muted">{view.emptyLabel}</p>;
  return <div className="changes-diff">
    <div className="diff-toolbar"><span className="muted small-text">{label}</span><label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} /> Wrap lines</label></div>
    {view.sections.map((section, index) => <details className="diff-file" open key={index}>
      <summary><span className="diff-file-path" title={section.path}>{section.path}</span><span className="diff-stats"><span className="added">+{section.added}</span><span className="removed">−{section.removed}</span></span></summary>
      <div className={`diff-scroll${wrap ? ' wrap' : ''}`} tabIndex={0} aria-label={`Diff for ${section.path}`}>
        <div className="diff-lines">{section.rows.map((row, line) => <div className={`diff-line ${row.kind}`} key={line}>
          <span className="diff-line-number" aria-hidden="true">{row.before}</span><span className="diff-line-number" aria-hidden="true">{row.after}</span><code>{row.line || ' '}</code>
        </div>)}</div>
      </div>
    </details>)}
  </div>;
}
