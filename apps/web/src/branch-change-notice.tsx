import { branchChangeView, type GitBranchChange, type BranchChangeView } from '@jevellan/core/client';
export { branchChangeText } from '@jevellan/core/client';
export function BranchChangeNotice({ change, presentation }: { change: GitBranchChange; presentation?: BranchChangeView | undefined }) {
  const view = presentation ?? branchChangeView(change);
  return <section className="notice branch-change-notice" role="alert">
    <strong>{view.title}</strong>
    <p><code>{view.from}</code> → <code>{view.to}</code></p>
    <p>{view.body}</p>
  </section>;
}
