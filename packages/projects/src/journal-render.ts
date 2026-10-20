import { createHash } from 'node:crypto';
import { JournalConfigSchema, JournalDocumentSchema, JournalThreadSchema, parseProjectLedgerData, type JournalThread, type ProjectJournalRecord, type ProjectLedgerEventType } from '@jevellan/core';
import { MemoryDreamReportSchema, MergeDocumentSchema, ProjectDecisionSchema, ProjectJobRunSchema, ProjectRefillStateSchema, ProjectWindowSchema, ProjectWorkTaskSchema, TaskHistoryEventSchema } from '@jevellan/core';

export function validateJournalDocument(raw: unknown) {
  const data = JournalDocumentSchema.parse(raw);
  const schemas = { task: ProjectWorkTaskSchema, 'task-history': TaskHistoryEventSchema, question: ProjectDecisionSchema, job: ProjectJobRunSchema,
    refill: ProjectRefillStateSchema, window: ProjectWindowSchema, merge: MergeDocumentSchema, dream: MemoryDreamReportSchema };
  schemas[data.collection].parse(data.document); return data;
}

/**
 * The version of the text this renderer produces for a recorded event. Bump it whenever the text of an existing entry changes:
 * the hub then rebuilds each journal once instead of refusing a projection that no longer extends the files on disk.
 * 2: entries render their recorded payload, not the payload as a later schema parses it.
 */
export const JOURNAL_RENDERER = 2;
export const journalRecordKey = (record: ProjectJournalRecord): string => `${record.deviceId}-${record.ledgerId}-${record.event.id}`;
const line = (text: string): string => text.replace(/[\r\n]+/gu, ' ');
const quote = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
export const threadJournalFile = (thread: Pick<JournalThread, 'id' | 'title'>): string => {
  const slug = thread.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'thread';
  return `threads/${slug}-${createHash('sha256').update(thread.id).digest('hex').slice(0, 12)}.md`;
};
export function journalDate(at: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
function clock(at: string, timezone: string): string {
  return `${journalDate(at, timezone)} ${new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at))}`;
}
export type JournalEntry = { record: ProjectJournalRecord; kind: string; body: string; threadId?: string; night?: string; owner?: boolean; question?: boolean; merged?: boolean };
export function journalEntry(record: ProjectJournalRecord): JournalEntry | null {
  const { type } = record.event;
  if (['journal-source', 'coordinator-turn-start', 'coordinator-turn-end', 'thread-turn-start', 'thread-turn-end', 'session-turn-cache', 'project-session-end', 'thread-placement'].includes(type)) return null;
  parseProjectLedgerData(type as ProjectLedgerEventType, record.event.data);
  // The recorded payload, not the parsed one: a default or transform a later schema adds must never change an entry already written.
  const data = record.event.data as Record<string, unknown>;
  const threadId = record.ledgerId !== 'coordinator' ? record.ledgerId : typeof data.threadId === 'string' ? data.threadId : undefined;
  const base = { record, ...(threadId ? { threadId } : {}) };
  if (type === 'journal-thread') {
    JournalThreadSchema.parse(data); const { task: _task, ...metadata } = data; void _task;
    return { ...base, kind: 'Thread metadata', body: quote(metadata) };
  }
  if (type === 'coordinator-text') return { ...base, kind: 'Coordinator', body: String(data.text) };
  if (type === 'coordinator-event') {
    const kind = String(data.kind);
    return { ...base, kind, owner: kind === 'user-message', question: kind === 'decision-answer' || kind === 'thread-report' && !!(data.report as Record<string, unknown> | undefined)?.question,
      merged: kind === 'automatic-merge' || kind === 'pr-update' && data.change === 'merged', body: kind === 'user-message' || kind === 'thread-user-message' ? String(data.text) : quote(data) };
  }
  if (type === 'coordinator-tool') {
    if (!data.ok) return { ...base, kind: 'Coordinator tool failed', body: String(data.summary) };
    if (['jevellan_thread_message', 'jevellan_ask_user', 'jevellan_answer_question', 'jevellan_task_create', 'jevellan_review_followup'].includes(String(data.tool))) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(String(data.input ?? '{}')) as Record<string, unknown>; } catch { /* retain the recorded text */ }
      return { ...base, ...(typeof input.threadId === 'string' ? { threadId: input.threadId } : {}), kind: String(data.tool),
        question: data.tool === 'jevellan_ask_user', body: `${String(data.summary)}\n\n${String(data.input ?? '')}${data.inputTruncated ? '\n(The original tool input was truncated in the ledger.)' : ''}` };
    }
    return null;
  }
  if (type === 'journal-document') {
    const source = JournalDocumentSchema.parse(data), document = data.document as Record<string, unknown>;
    const summary = source.collection === 'job'
      ? `Result: ${String(document.conclusion ?? document.phase)}\nCommit: ${String(document.commit)}${typeof document.url === 'string' ? `\nRun: [Open run](${document.url})` : ''}\n\n${String(document.summary ?? '')}\n\n`
      : source.collection === 'window' ? `Night: ${String(document.date)} · ${String(document.state)}\n\n${String(document.outcome ?? '')}\n\n`
        : source.collection === 'merge' ? `Route or verification: ${String(document.route ?? document.state)}\nCommit: ${String(document.commit)}\n\n${String(document.reason ?? document.note ?? '')}\n\n`
          : source.collection === 'dream' ? `${String(document.summary ?? '')}\n\n` : '';
    return { ...base, ...(typeof document.threadId === 'string' ? { threadId: document.threadId } : {}), kind: source.collection,
      question: source.collection === 'question' && !document.answer, merged: source.collection === 'merge' && document.state === 'merged', body: summary + quote(document) };
  }
  if (type === 'thread-report') return { ...base, kind: 'Thread report', body: `Status: ${String(data.status)}\n\n${String(data.summary)}\n\n${quote(data)}` };
  return { ...base, kind: type, body: quote(data) };
}

export type JournalIndexDay = { date: string; ownerMessages: number; ended: Array<{ thread: JournalThread; outcome: string }>; questions: number; night?: { summary: string; failed: boolean } };
export type JournalIndexInput = { name: string; updatedAt: string; timezone: string; open: string[]; days: JournalIndexDay[] };
function isoWeek(date: string): string {
  const day = new Date(`${date}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear(), start = new Date(Date.UTC(year, 0, 1));
  return `${year}-W${String(Math.ceil((((day.getTime() - start.getTime()) / 86400000) + 1) / 7)).padStart(2, '0')}`;
}
/** Fold old weeks, then oldest per-thread lines, then whole days. Open state is never discarded. */
export function journalIndex(input: JournalIndexInput, cap = 12000): string {
  const latest = journalDate(input.updatedAt, input.timezone), boundary = new Date(`${latest}T12:00:00Z`); boundary.setUTCDate(boundary.getUTCDate() - 6);
  const first = boundary.toISOString().slice(0, 10), recent = input.days.filter(day => day.date >= first).sort((a, b) => b.date.localeCompare(a.date));
  const earlier = input.days.filter(day => day.date < first), collapsed = new Set<string>();
  const weeks = (days: JournalIndexDay[]) => {
    const values = new Map<string, { threads: number; merged: number; nights: number; failed: number }>();
    for (const day of days) {
      const key = isoWeek(day.date), value = values.get(key) ?? { threads: 0, merged: 0, nights: 0, failed: 0 };
      value.threads += day.ended.length; value.merged += day.ended.filter(row => row.thread.state === 'done' && row.thread.pr !== null).length;
      value.nights += day.night ? 1 : 0; value.failed += day.night?.failed ? 1 : 0; values.set(key, value);
    }
    return [...values].sort(([a], [b]) => b.localeCompare(a)).map(([week, value]) => `- Week ${week}: ${value.threads} threads (${value.merged} merged), ${value.nights} nights (${value.failed} failed) → days/ and threads/ files of that week`);
  };
  const render = () => [`# ${line(input.name)} journal (updated ${clock(input.updatedAt, input.timezone)})`, '', '## Open now',
    ...(input.open.length ? input.open : ['(none)']), '', '## Last 7 days',
    ...recent.flatMap(day => [
      `- ${day.date}: ${day.ownerMessages} owner messages, ${day.ended.length} threads ended (${day.ended.filter(row => row.thread.state === 'done' && row.thread.pr !== null).length} merged), ${day.questions} questions → days/${day.date}.md`,
      ...(collapsed.has(day.date) ? [] : day.ended.map(({ thread, outcome }) => `  - "${line(thread.title)}": ${line(outcome)}${thread.pr ? `, PR #${thread.pr}` : ''} → ${threadJournalFile(thread)}`)),
      ...(day.night ? [`- Night ${day.date}: ${line(day.night.summary)} → nights/${day.date}.md`] : []),
    ]), '', '## Earlier', ...weeks(earlier), ''].join('\n');
  let result = render();
  for (const day of [...recent].reverse()) { if (result.length <= cap) break; collapsed.add(day.date); result = render(); }
  while (result.length > cap && recent.length) { earlier.push(recent.pop()!); result = render(); }
  // An arbitrarily long history folds into one exact aggregate; no open entry is removed.
  if (result.length > cap && earlier.length) {
    const section = result.indexOf('\n## Earlier\n');
    result = `${result.slice(0, section)}\n## Earlier\n- ${earlier.length} earlier days → days/ and threads/ files\n`;
  }
  if (result.length > cap) throw new Error('Open now exceeds the journal index allowance; its entries were preserved.');
  return result;
}

export function renderProjectJournal(input: { name: string; timezone: string; records: ProjectJournalRecord[]; open: string[]; updatedAt: string }): { files: Record<string, string>; days: JournalIndexDay[] } {
  const headers = new Map<string, JournalThread>(), windows = new Map<string, string>();
  for (const record of input.records) if (record.event.type === 'journal-thread') {
    const header = JournalThreadSchema.parse(record.event.data); if (!headers.has(header.id)) headers.set(header.id, header);
  }
  for (const record of input.records) if (record.event.type === 'journal-document') {
    const data = JournalDocumentSchema.parse(record.event.data);
    if (data.collection === 'window' && typeof data.document.date === 'string') windows.set(data.key, data.document.date);
  }
  const initial = input.records.find(record => record.event.type === 'journal-config');
  let config = initial ? JournalConfigSchema.parse(initial.event.data) : { name: input.name, timezone: input.timezone };
  const files: Record<string, string> = {}, days = new Map<string, JournalIndexDay>(), visibleHeaders = new Set<string>(), questions = new Set<string>(), ownerMessages = new Set<string>();
  const dayRow = (date: string) => { let row = days.get(date); if (!row) { row = { date, ownerMessages: 0, ended: [], questions: 0 }; days.set(date, row); } return row; };
  for (const header of headers.values()) files[threadJournalFile(header)] = `# ${header.title}\n\nTask: ${header.taskId ?? '(none)'}\nGoal: ${header.goal ?? '(none)'}\nType: ${header.type ?? '(none)'}\nRuntime: ${header.runtime}\nModel: ${header.model}\nEffort: ${header.effort}\nDevice: ${header.deviceId}\nIsolation: ${header.isolation}\nBranch: ${header.branch ?? '(not yet created)'}\nPull request: ${header.pr === null ? '(none)' : `#${header.pr}`}\nState when recorded: ${header.state}\nCreated: ${header.createdAt}\nEnded when recorded: ${header.endedAt ?? '(not ended)'}\n\n## Task brief\n\n${header.task}\n\n## Entries\n`;
  for (const record of input.records) {
    if (record.event.type === 'journal-config') config = JournalConfigSchema.parse(record.event.data);
    if (record.event.type === 'journal-thread') visibleHeaders.add(JournalThreadSchema.parse(record.event.data).id);
    const entry = journalEntry(record); if (!entry) continue;
    const date = journalDate(record.event.t, config.timezone), row = dayRow(date), thread = entry.threadId ? headers.get(entry.threadId) : undefined;
    const threadPath = thread ? threadJournalFile(thread) : undefined, anchor = `e-${journalRecordKey(record)}`;
    const text = `\n### ${clock(record.event.t, config.timezone)} ${entry.kind}\n<a id="${anchor}"></a>\n\n${entry.body}\n`;
    let night: string | undefined;
    if (record.event.type === 'journal-document') {
      const data = JournalDocumentSchema.parse(record.event.data), windowId = data.nightlyWindowId ?? data.document.nightlyWindowId;
      night = data.collection === 'window' ? windows.get(data.key) : typeof windowId === 'string' ? windows.get(windowId) : undefined;
      if (data.collection === 'window' && night) dayRow(night).night = { summary: String(data.document.outcome ?? data.document.state), failed: data.document.failed === true };
    }
    if (night) files[`nights/${night}.md`] = (files[`nights/${night}.md`] ?? `# ${config.name} · Night ${night}\n`) + text;
    if (threadPath) files[threadPath] = (files[threadPath] ?? '') + text;
    const path = `days/${date}.md`;
    files[path] = (files[path] ?? `# ${config.name} · ${date}\n`) + text + (threadPath && visibleHeaders.has(thread!.id) ? `\nThread: [${thread!.title}](../${threadPath}#${anchor})\n` : '');
    if (entry.owner) {
      const eventId = String((record.event.data as Record<string, unknown>).id);
      if (!ownerMessages.has(eventId)) { ownerMessages.add(eventId); row.ownerMessages++; }
    }
    if (record.event.type === 'journal-document') {
      const data = JournalDocumentSchema.parse(record.event.data);
      if (data.collection === 'question' && !questions.has(data.key)) { questions.add(data.key); row.questions++; }
    }
    if (thread && record.event.type === 'thread-state') {
      const data = parseProjectLedgerData('thread-state', record.event.data);
      thread.state = data.to;
      if (['done', 'stopped', 'failed'].includes(data.to) && !row.ended.some(value => value.thread.id === thread.id)) {
        thread.endedAt = record.event.t; row.ended.push({ thread: structuredClone(thread), outcome: data.reason ?? data.to });
      }
    }
    if (thread && record.event.type === 'thread-publication') { const data = parseProjectLedgerData('thread-publication', record.event.data); if (data.prNumber) thread.pr = data.prNumber; }
  }
  files['INDEX.md'] = journalIndex({ name: input.name, updatedAt: input.updatedAt, timezone: input.timezone, open: input.open, days: [...days.values()] });
  return { files, days: [...days.values()] };
}
