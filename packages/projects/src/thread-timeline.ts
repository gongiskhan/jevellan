import { joinToolTurns, prepareTranscriptGroups, ThreadReportPresentationSchema, ThreadTimelineSchema,
  type CursorTurn, type QueuedMessage, type ThreadReport, type ThreadReportPresentation, type ThreadTimeline, type ThreadView } from '@jevellan/core';
import * as copy from './copy.js';
type BadgeTone = ThreadReportPresentation['badge']['tone'];

const REPORT_TONES = { progress: 'muted', done: 'ok', 'needs-decision': 'jev', blocked: 'warn' } as const satisfies Record<ThreadReport['status'], BadgeTone>;
/** A report card's status chip: progress muted, done ok, a decision magenta like Waiting for you, blocked warn. */
export function reportBadge(status: ThreadReport['status']): { text: string; tone: BadgeTone } {
  return { text: copy.REPORT_STATUS[status], tone: REPORT_TONES[status] };
}

export type TranscriptItem = { kind: 'turn'; turn: CursorTurn; fix?: import('@jevellan/core').ThreadFix } | { kind: 'report'; report: ThreadReport };

export function mergeThreadToolTurns(items: readonly TranscriptItem[]): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    const joined = item.kind === 'turn' && previous?.kind === 'turn' ? joinToolTurns(previous.turn, item.turn) : undefined;
    if (joined) result[result.length - 1] = { ...previous, kind: 'turn', turn: joined }; else result.push(item);
  }
  return result;
}

const REPORT_TOOL = 'jevellan_thread_report';
const isPrompt = (turn: CursorTurn) => turn.role === 'user' && !turn.automated;
/** The summary a `jevellan_thread_report` call carries, if the block is one. */
function reportSummary(block: CursorTurn['blocks'][number]): string | undefined {
  if (block.type !== 'tool' || block.name.split('__').at(-1) !== REPORT_TOOL) return undefined;
  try {
    const input: unknown = JSON.parse(block.input);
    const summary = input && typeof input === 'object' ? (input as Record<string, unknown>).summary : undefined;
    return typeof summary === 'string' ? summary : undefined;
  } catch { return undefined; }
}
function reportedSummaries(segment: readonly CursorTurn[]): string[] {
  return segment.flatMap((turn) => turn.blocks.flatMap((block) => { const summary = reportSummary(block); return summary === undefined ? [] : [summary]; }));
}
/**
 * Report cards placed after the turn they report (D56). The transcript splits into one segment per Jevellan turn prompt
 * (a non-automated user turn); segments take turn numbers from the end. The anchor is the latest segment whose
 * `jevellan_thread_report` call carries the summary of a recorded report; without one, the last segment is turn `latest`
 * (the caller passes `turns + 1` while a turn runs), else the last report's turn. Reports older than the transcript come
 * first, reports newer than it last; with no transcript they are simply in order.
 */
export function alignReports(turns: readonly CursorTurn[], reports: readonly ThreadReport[], latest?: number, fixes: readonly { turn: number; fix: import('@jevellan/core').ThreadFix }[] = []): TranscriptItem[] {
  const prefix: CursorTurn[] = []; const segments: CursorTurn[][] = [];
  for (const turn of turns) {
    if (isPrompt(turn)) segments.push([turn]);
    else (segments.at(-1) ?? prefix).push(turn);
  }
  const ordered = [...reports].sort((a, b) => a.turn - b.turn);
  const recorded = ordered.filter((report) => !report.synthesized).reverse();
  let first: number | undefined;
  for (let index = segments.length - 1; index >= 0 && first === undefined; index--) {
    const summaries = reportedSummaries(segments[index]!);
    const report = summaries.length ? recorded.find((candidate) => summaries.includes(candidate.summary)) : undefined;
    if (report) first = report.turn - index;
  }
  first ??= (latest ?? ordered.at(-1)?.turn ?? segments.length) - segments.length + 1;
  const items: TranscriptItem[] = []; let next = 0;
  const reportsUpTo = (turn: number) => { while (next < ordered.length && ordered[next]!.turn <= turn) items.push({ kind: 'report', report: ordered[next++]! }); };
  reportsUpTo(first - 2);
  for (const turn of prefix) items.push({ kind: 'turn', turn });
  reportsUpTo(first - 1);
  segments.forEach((segment, index) => { const fix = fixes.find(row => row.turn === first + index)?.fix; for (const turn of segment) items.push({ kind: 'turn', turn, ...(isPrompt(turn) && fix ? { fix } : {}) }); reportsUpTo(first + index); });
  reportsUpTo(Infinity);
  return items;
}
/**
 * The transcript as the thread page shows it (D245): a completed `jevellan_thread_report` call whose summary is a recorded
 * report is left out, because that report's card follows the turn (the raw call read as an internal tool name above every
 * card). A running, failed or refused call stays (a refusal can read as completed: Codex results carry no error flag). A
 * turn left without blocks is dropped. Run it after `alignReports`, which anchors on those calls.
 */
export function withoutReportCalls(items: readonly TranscriptItem[], reports: readonly ThreadReport[]): TranscriptItem[] {
  const recorded = new Set(reports.filter((report) => !report.synthesized).map((report) => report.summary));
  const shown = (block: CursorTurn['blocks'][number]) => {
    const summary = block.type === 'tool' && block.state === 'completed' ? reportSummary(block) : undefined;
    return summary === undefined || !recorded.has(summary);
  };
  return items.flatMap((item): TranscriptItem[] => {
    if (item.kind !== 'turn') return [item];
    const blocks = item.turn.blocks.filter(shown);
    if (blocks.length === item.turn.blocks.length) return [item];
    return blocks.length ? [{ ...item, turn: { ...item.turn, blocks } }] : [];
  });
}
/**
 * The thread page shows a turn's closing words once: when the last block of the agent turn right before a report card is
 * text that reads the same as the report's summary (both trimmed), the card carries it and the text is left out; a turn
 * left without blocks is dropped. Any other text, a prompt, or text followed by another block stays. Run it after
 * `withoutReportCalls`, so a report call removed there no longer sits between the text and its card.
 */
export function withoutEchoedSummaries(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.flatMap((item, index): TranscriptItem[] => {
    const next = items[index + 1];
    if (item.kind !== 'turn' || item.turn.role !== 'assistant' || next?.kind !== 'report') return [item];
    const last = item.turn.blocks.at(-1);
    if (last?.type !== 'text' || last.text.trim() !== next.report.summary.trim()) return [item];
    const blocks = item.turn.blocks.slice(0, -1);
    return blocks.length ? [{ ...item, turn: { ...item.turn, blocks } }] : [];
  });
}

export function reportPresentation(projectId: string, report: ThreadReport): ThreadReportPresentation {
  return ThreadReportPresentationSchema.parse({ schema: 'project-thread-report-presentation-v1', projectId,
    heading: copy.reportHeading(report.turn), badge: reportBadge(report.status), fixLabel: report.fix ? copy.fixTurnLabel(report.fix) : null,
    synthesizedNotice: report.synthesized ? copy.SYNTHESIZED_REPORT : null, preview: report.summary.split('\n').find(line => line.trim())?.slice(0, 220) ?? '',
    tests: report.testsRun ? { label: report.testsRun.passed ? copy.TESTS_PASSED : copy.TESTS_FAILED, tone: report.testsRun.passed ? 'ok' : 'danger', icon: report.testsRun.passed ? 'check' : 'close' } : null });
}
export function queuedPresentation(message: QueuedMessage) {
  return { schema: 'project-thread-queued-presentation-v1' as const, sourceLabel: message.from === 'owner' ? 'You' : 'Coordinator',
    interruptsLabel: message.interrupt ? copy.INTERRUPTS_TURN : null, preview: message.text.trim().split('\n')[0]?.slice(0, 160) ?? '' };
}
export function threadTimeline(view: ThreadView): ThreadTimeline {
  const running = view.thread.state === 'running', reports = view.reports;
  const aligned = withoutEchoedSummaries(withoutReportCalls(alignReports(view.transcript?.turns ?? [], reports,
    running ? view.thread.turns + 1 : view.thread.turns, view.fixTurns), reports));
  const items = mergeThreadToolTurns(aligned);
  return ThreadTimelineSchema.parse({ schema: 'project-thread-timeline-v1', projectId: view.thread.projectId, threadId: view.thread.id,
    items: items.map((item, index) => item.kind === 'turn'
      ? { ...item, fixLabel: item.fix ? copy.fixTurnLabel(item.fix) : null, active: running && index === items.length - 1,
        groups: prepareTranscriptGroups(item.turn, running && index === items.length - 1) }
      : { ...item, presentation: reportPresentation(view.thread.projectId, item.report) }),
    queued: view.queuedMessages.map(message => ({ message, presentation: queuedPresentation(message) })) });
}
