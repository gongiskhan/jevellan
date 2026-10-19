import { MemoryRecallSchema, type MemoryNote, type MemoryRecall, type ThreadIndex } from '@jevellan/core';
import { JevError, deadlineClient, selectMemory, type DecisionSource } from '@jevellan/decisions';
import { HUB_MEMORY_OFFLINE, splitMemoryText, type ProjectMemoryPort } from '@jevellan/memory';

export async function projectRecall(source: ProjectMemoryPort | (() => ProjectMemoryPort), task: { title: string; brief: string },
  jev: { client?: DecisionSource; model: string }, signal: AbortSignal): Promise<MemoryRecall> {
  try {
    const memory = typeof source === 'function' ? source() : source;
    const brief = await memory.findTitle('Project brief', signal);
    const words = [...new Set((`${task.title} ${task.brief}`.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 64))];
    const candidates = words.length ? (await memory.search(words.join(' OR '), signal)).notes.filter(note => note.permalink !== brief?.permalink).slice(0, 12) : [];
    // A client that cannot be obtained ranks by search order, as without a key; the decision keeps the shared deadline (fix-051).
    const jevSource = jev.client, keyless = { decide: async () => { throw new JevError('no-key'); } };
    const client = deadlineClient(jevSource && Object.assign(async () => { try { return await jevSource(); } catch { return keyless; } }, jevSource.deadlineMs ? { deadlineMs: () => jevSource.deadlineMs!() } : {}));
    const { selection } = await selectMemory(client,
      { notes: candidates, action: 'implement', state: JSON.stringify({ title: task.title, brief: task.brief }), model: jev.model }, signal);
    const selected = selection.chosen.flatMap(ref => candidates.filter(note => note.permalink === ref));
    const body = (note: MemoryNote, max: number) => splitMemoryText(note.content).body.trim().slice(0, max);
    const notes = [...(brief ? [{ title: brief.title, permalink: brief.permalink, reason: 'The shared Project brief.' }] : []),
      ...selected.map(note => ({ title: note.title, permalink: note.permalink, reason: selection.source === 'jev' ? `Jev relevance ${selection.scores?.[note.permalink] ?? 0} of 3.` : 'Basic Memory search order; Jev was unavailable.' }))];
    const parts = ['Project memory:', ...(brief ? [`Project brief:\n${body(brief, 2000)}`] : []),
      ...selected.map(note => `- ${note.title}${note.permalink.startsWith('inbox/') ? ' (from today, not yet consolidated)' : ''}: ${body(note, 600)}`)];
    // Keep the search instruction even when long titles exhaust the section allowance.
    const end = '\nSearch memory with memory_search for more.';
    return MemoryRecallSchema.parse({ schema: 'project-memory-recall-v1', section: parts.join('\n').slice(0, 5000 - end.length) + end, source: selection.source, notes });
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error && error.message === HUB_MEMORY_OFFLINE ? HUB_MEMORY_OFFLINE : 'Project memory is unavailable for this turn.';
    return MemoryRecallSchema.parse({ schema: 'project-memory-recall-v1', section: `Project memory:\n${message}`, source: 'unavailable', notes: [] });
  }
}

export function coordinatorMemory(notes: readonly MemoryNote[]): string {
  const brief = notes.find(note => note.title === 'Project brief');
  return ['Project memory:', ...(brief ? [splitMemoryText(brief.content).body.trim().slice(0, 2000)] : []),
    'Recently updated notes:', ...notes.slice(0, 30).map(note => `- ${note.title}${note.permalink.startsWith('inbox/') ? ' (from today, not yet consolidated)' : ''}`),
    'Search memory with memory_search for more.'].join('\n');
}

/** Hub indexes supply live state; this block never enters durable memory or makes GitHub requests. */
export function projectNow(threads: readonly ThreadIndex[], self: string, base: string, deviceName: (id: string) => string,
  now = Date.now()): string {
  const active = threads.filter(thread => thread.id !== self && !['done', 'stopped', 'failed', 'queued'].includes(thread.state));
  const merged = threads.filter(thread => thread.pr?.state === 'merged' && Date.parse(thread.pr.updatedAt) >= now - 86_400_000);
  const bounded = (rows: string[], limit: number) => { const text = rows.length ? rows.join('\n') : '(none)'; return text.length <= limit ? text : text.slice(0, limit - 22) + '\n(more work omitted)'; };
  return [`Project now (${new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}):`, 'Other active threads:',
    bounded(active.map(thread => `- ${thread.title} (${thread.runtime} ${thread.modelLabel} on ${deviceName(thread.ownerDeviceId)}): ${thread.state}; working on ${thread.changedPaths?.slice(0, 8).join(', ') || '(none)'}; last report: ${thread.lastSummary?.slice(0, 160) || '(none)'}`), 1700),
    `Merged to ${base.slice(0, 100)} in the last 24 hours:`, bounded(merged.map(thread => `- #${thread.pr!.number} ${thread.title}: ${thread.changedPaths?.slice(0, 5).join(', ') || '(none)'}`), 550)].join('\n');
}
