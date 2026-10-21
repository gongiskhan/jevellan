import type { GitBranchChange } from './schemas.js';
import { BranchChangeViewSchema, ChangesDiffViewSchema, MessageDeliveryViewSchema, type BranchChangeView, type ChangesDiffView, type MessageDeliveryView } from './conversation-reading-view-schemas.js';
export function branchChangeText(change: GitBranchChange) {
  return `${change.status === 'completed' ? 'Switched' : 'Switching'} from ${change.from} to main.${change.createdRemote ? ` Main ${change.status === 'completed' ? 'was created' : 'will be created'} from published branch history, locally and on origin.` : ''} The original branch is preserved.`;
}

export function branchChangeView(change: GitBranchChange): BranchChangeView {
  return BranchChangeViewSchema.parse({ schema: 'branch-change-view-v1', title: change.status === 'completed' ? 'Switched to main' : 'Switching to main', from: change.from, to: change.to, text: branchChangeText(change),
    body: `${change.createdRemote ? `Main ${change.status === 'completed' ? 'was created' : 'will be created'} from the published branch history, locally and on origin. ` : ''}The original branch is preserved. ${change.status === 'completed' ? 'Work continues on main.' : 'Jevellan will work on main after switching.'}` });
}
export function messageDeliveryView({ running, canSteer = true, canSend = true, cursor = false }: { running: boolean; canSteer?: boolean; canSend?: boolean; cursor?: boolean }): MessageDeliveryView {
  const primary = running ? 'Steer' : 'Send';
  const unavailable = cursor ? 'Connection hooks and an active Cursor turn are needed. Use the session’s settings in the list.' : 'Message delivery is unavailable.';
  return MessageDeliveryViewSchema.parse({ schema: 'message-delivery-view-v1', canSend, canSteer, canQueue: running && canSend, reason: !(running ? canSteer : canSend) || !canSend ? unavailable : null,
    primaryLabel: primary, primaryTitle: !(running ? canSteer : canSend) ? unavailable : running ? cursor ? 'Steer after the next tool call' : 'Steer current work' : 'Send message', primaryEnabled: running ? canSteer : canSend,
    queueLabel: 'Queue message', queueTitle: !canSend ? unavailable : running ? 'Queue for when current work finishes' : 'Queue is available while work is running', queueEnabled: running && canSend });
}
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

export function changesDiffView(text: string): ChangesDiffView {
  const sections = text.trimEnd().split(/(?=^diff --git )/m).filter(Boolean).map(part => {
    const rows = diffRows(part);
    const paths = part.split('\n').filter(line => /^(\+\+\+|---) /.test(line)).map(line => line.slice(4)).filter(path => path !== '/dev/null');
    const path = (paths.at(-1) ?? part.split('\n')[0] ?? 'Changes').replace(/^[ab]\//, '');
    return { rows, path, added: rows.filter(row => row.kind === 'addition').length, removed: rows.filter(row => row.kind === 'removal').length };
  });
  return ChangesDiffViewSchema.parse({ schema: 'changes-diff-view-v1', empty: !text, emptyLabel: 'No checkpoint changes in this step.', sections });
}
