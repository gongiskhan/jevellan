import { changesDiffView } from '@jevellan/core/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { ChangesDiff } from './changes-diff.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

type WorktreeDiff = { schema: 'worktree-diff-v1'; scope: 'checkout' | 'worktree'; cwd: string; branch: string; head: string; files: { path: string; status: string }[]; text: string; truncated: boolean };
const WorktreeDiffSchema = { parse(value: unknown): WorktreeDiff {
  const doc = value as WorktreeDiff;
  if (!doc || doc.schema !== 'worktree-diff-v1' || !Array.isArray(doc.files) || typeof doc.text !== 'string') throw new Error('Unexpected changes reply.');
  return doc;
} };

/** Uncommitted changes (tracked and untracked) of a project checkout or a thread worktree, as a file list and the selected file's diff. */
export function WorktreeChanges({ path, title, close }: { path: string; title: string; close(): void }) {
  const [diff, setDiff] = useState<WorktreeDiff>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>();
  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true); setError('');
    api(path, WorktreeDiffSchema, 'GET', undefined, signal ? { signal } : {})
      .then(value => { setDiff(value); setLoading(false); })
      .catch((failure: unknown) => { if (signal?.aborted) return; setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); });
  }, [path]);
  useEffect(() => { const controller = new AbortController(); load(controller.signal); return () => controller.abort(); }, [load]);
  const view = useMemo(() => diff ? changesDiffView(diff.text) : undefined, [diff]);
  const sections = view?.sections ?? [];
  const sectionFor = (file: string) => sections.find(section => section.path === file);
  const current = selected ?? diff?.files[0]?.path;
  const section = current ? sectionFor(current) : undefined;
  return <div className="worktree-changes-dialog"><Modal title={title} close={close}>
    <div className="worktree-changes-bar">
      <span className="muted small-text" title={diff?.cwd}>{diff ? `${diff.branch || 'detached'} @ ${diff.head || 'no commits'} · ${diff.files.length} changed file${diff.files.length === 1 ? '' : 's'}${diff.truncated ? ' · truncated' : ''}` : loading ? 'Loading…' : ''}</span>
      <button type="button" className="secondary" disabled={loading} onClick={() => load()}>Refresh</button>
    </div>
    {error && <p className="error">{error}</p>}
    {diff && diff.files.length === 0 && <p className="muted">No uncommitted changes.</p>}
    {diff && diff.files.length > 0 && <div className="worktree-changes">
      <ul className="worktree-changes-files">
        {diff.files.map(file => { const stats = sectionFor(file.path); return <li key={file.path}>
          <button type="button" className={file.path === current ? 'selected' : ''} onClick={() => setSelected(file.path)} title={file.path}>
            <span className={`worktree-status ${file.status}`}>{file.status[0]!.toUpperCase()}</span>
            <span className="worktree-file-path">{file.path}</span>
            {stats && <span className="diff-stats"><span className="added">+{stats.added}</span><span className="removed">−{stats.removed}</span></span>}
          </button>
        </li>; })}
      </ul>
      <div className="worktree-changes-diff">
        {section ? <ChangesDiff text="" label={section.path} view={{ ...view!, empty: false, sections: [section] }} />
          : <p className="muted">{current ? 'No text diff for this file (binary, too large, or a folder).' : ''}</p>}
      </div>
    </div>}
  </Modal></div>;
}

export function ChangesButton({ path, title }: { path: string; title: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="secondary pw-head-button" aria-label="Uncommitted changes" title="Uncommitted changes" onClick={() => setOpen(true)}>
      <Icon name="diff" size={15} /><span className="pw-head-label">Changes</span>
    </button>
    {open && <WorktreeChanges path={path} title={title} close={() => setOpen(false)} />}
  </>;
}
