import { IdSchema, RESTARTED_PREFIX, THREAD_READ_POLICY, ThreadPresentationSchema, isTerminal, splitSavedCommits,
  type ThreadIndex, type ThreadPresentation, type ThreadView } from '@jevellan/core';
import * as copy from './copy.js';

/**
 * The thread header buttons (12.3): Stop while the thread is not concluded, Discard when the owner may discard it (the
 * server decides), Allow 10 more turns at the turn limit of a thread that has not concluded.
 */
/** `stopRefusal`: Stop shows disabled with the server's reason (an attached thread, phase 8). */
export function threadActions(view: Pick<ThreadView, 'thread' | 'canDiscard' | 'atTurnLimit' | 'stopRefusal'>): { stop: boolean; stopRefusal: string | null; discard: boolean; allowTurns: boolean } {
  const ended = isTerminal(view.thread.state);
  return { stop: !ended, stopRefusal: ended ? null : view.stopRefusal ?? null, discard: view.canDiscard, allowTurns: view.atTurnLimit && !ended };
}
/** Why the thread composer takes no message (D81), or null: attached in a terminal, else concluded. */
export function composerBlock(view: Pick<ThreadView, 'canMessage' | 'thread' | 'deviceName'>): string | null {
  if (view.canMessage) return null;
  return view.thread.state === 'attached' ? copy.attachedNotice(view.deviceName) : copy.THREAD_ENDED;
}
/** The composer's live line: the running turn (turns count finished ones), the preparation or the publication. */
export function threadLiveText(thread: Pick<ThreadIndex, 'state' | 'turns'>): string | null {
  return thread.state === 'running' ? copy.turnRunning(thread.turns + 1) : thread.state === 'preparing' ? copy.PREPARING
    : thread.state === 'publishing' ? copy.PUBLISHING : null;
}
/** Show the latest tool's stated purpose while its result is pending, without inferring process health. */
export function threadActivity(view: Pick<ThreadView, 'thread' | 'transcript'>): string | null {
  if (view.thread.state !== 'running') return null;
  const turn = view.transcript?.turns.at(-1);
  if (turn?.role !== 'assistant') return null;
  const block = turn.blocks.at(-1);
  if (block?.type !== 'tool' || block.output !== undefined || !['running', 'unknown'].includes(block.state)) return null;
  let purpose = block.name;
  try {
    const input: unknown = JSON.parse(block.input);
    if (input && typeof input === 'object' && 'description' in input && typeof input.description === 'string') purpose = input.description;
  } catch { /* Partial tool input still has its tool name. */ }
  return `Waiting for tool result: ${purpose.slice(0, 180)}`;
}
/** The note above a thread transcript: none yet, unreadable (reports still show) or only its most recent part. */
export function transcriptNotice(view: Pick<ThreadView, 'transcript' | 'reports' | 'thread'>): string | null {
  if (!view.transcript) return view.reports.length || view.thread.turns ? copy.TRANSCRIPT_UNAVAILABLE : copy.NO_TRANSCRIPT_YET;
  if (!view.transcript.turns.length && !view.reports.length) return copy.NO_TRANSCRIPT_YET;
  return view.transcript.truncated ? copy.TRANSCRIPT_TRUNCATED : null;
}

/** The new thread's id in a restarted thread's reason (`Restarted as {newId}.`, brief 10), so the page can link it; else null. */
export function restartedThread(reason: string | undefined): string | null {
  if (!reason?.startsWith(RESTARTED_PREFIX) || !reason.endsWith('.')) return null;
  const id = reason.slice(RESTARTED_PREFIX.length, -1);
  return IdSchema.safeParse(id).success ? id : null;
}
/**
 * A thread's reason in parts (D295): the free text the header clamps, the restarted thread it links, and the ref a main thread's
 * unpublished commits were saved at, which the header shows whole on its own line (the owner needs it to recover them).
 */
export function threadReason(reason: string | undefined): { text: string; restartedAs: string | null; savedRef: string | null } | null {
  if (!reason) return null;
  const { text, ref } = splitSavedCommits(reason);
  return { text, restartedAs: restartedThread(text), savedRef: ref };
}


/** Render facts from the canonical owner-device reader; no provider or mutation is needed. */
export function threadPresentation(view: ThreadView): ThreadPresentation {
  const running = view.thread.state === 'running';
  return ThreadPresentationSchema.parse({ schema: 'project-thread-presentation-v1',
    actions: { ...threadActions(view), allowTurnsStep: copy.MORE_TURNS, allowTurnsLabel: copy.ALLOW_MORE_TURNS, allowedNotice: copy.MORE_TURNS_ALLOWED },
    composer: { running, ended: !view.canMessage && view.thread.state !== 'attached', block: composerBlock(view),
      continueNotice: ['done', 'stopped', 'failed'].includes(view.thread.state) && view.canMessage ? copy.THREAD_CONTINUE : null },
    live: { text: threadLiveText(view.thread), activity: threadActivity(view) }, transcriptNotice: transcriptNotice(view),
    reason: threadReason(view.thread.stateReason), readPolicy: THREAD_READ_POLICY });
}
