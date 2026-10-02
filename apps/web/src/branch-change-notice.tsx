import type { GitBranchChange } from '@jevellan/core/client';

export function branchChangeText(change: GitBranchChange) {
  return `${change.status === 'completed' ? 'Switched' : 'Switching'} from ${change.from} to main.${change.createdRemote ? ` Main ${change.status === 'completed' ? 'was created' : 'will be created'} from published branch history, locally and on origin.` : ''} The original branch is preserved.`;
}
export function BranchChangeNotice({ change }: { change: GitBranchChange }) {
  return <section className="notice branch-change-notice" role="alert">
    <strong>{change.status === 'completed' ? 'Switched to main' : 'Switching to main'}</strong>
    <p><code>{change.from}</code> → <code>main</code></p>
    <p>{change.createdRemote ? `Main ${change.status === 'completed' ? 'was created' : 'will be created'} from the published branch history, locally and on origin. ` : ''}The original branch is preserved. {change.status === 'completed' ? 'Work continues on main.' : 'Jevellan will work on main after switching.'}</p>
  </section>;
}
