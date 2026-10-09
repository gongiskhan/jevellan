import { setTimeout as wait } from 'node:timers/promises';
import { AgentEventPageSchema, AgentWatchCursorSchema, AgentWatchRequestSchema, AgentWatchResultSchema, type AgentApi, type AgentOutputEvent, type AgentWatchCursor, type AgentWatchRequest, type AgentWatchResult } from './schemas.js';
import { outputBlocks } from './format.js';

export function encodeAgentCursor(cursor: AgentWatchCursor): string {
  return Buffer.from(JSON.stringify(AgentWatchCursorSchema.parse(cursor))).toString('base64url');
}
export function decodeAgentCursor(raw: string): AgentWatchCursor {
  if (!/^[A-Za-z0-9_-]+$/u.test(raw) || raw.length > 4096) throw new Error('The output cursor is invalid.');
  try { return AgentWatchCursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))); }
  catch { throw new Error('The output cursor is invalid.'); }
}

/** Each target owns an independent durable position. A disconnect cancels waiting, never the job. */
export async function watchAgentOutput(api: AgentApi, raw: AgentWatchRequest, signal: AbortSignal, progress?: (result: AgentWatchResult) => Promise<void>): Promise<AgentWatchResult> {
  const input = AgentWatchRequestSchema.parse(raw);
  let cursor = input.cursor === undefined ? { schema: 'agent-watch-cursor-v1' as const, target: input.target, after: input.after ?? 0 } : decodeAgentCursor(input.cursor);
  if (JSON.stringify(cursor.target) !== JSON.stringify(input.target)) throw new Error('This output cursor belongs to another project or job.');
  if (input.after !== undefined && input.after !== cursor.after) throw new Error('Use the returned cursor unchanged, or an after position without a cursor.');
  const initial = cursor;
  const deadline = Date.now() + Math.max(input.waitMs, input.streamMs);
  const collected: AgentOutputEvent[] = [];
  let state: string | undefined;
  const resultFor = (events: AgentOutputEvent[], before: AgentWatchCursor, hasMore: boolean, timedOut: boolean): AgentWatchResult => {
    const grouped = outputBlocks(events, before.group);
    const next = { ...before, after: events.at(-1)?.id ?? before.after, ...(grouped.group === undefined ? {} : { group: grouped.group }) };
    return AgentWatchResultSchema.parse({ schema: 'agent-watch-result-v1', target: input.target, cursor: encodeAgentCursor(next), after: next.after,
      events, blocks: grouped.blocks, hasMore, timedOut, ...(state === undefined ? {} : { state }), markdown: grouped.blocks.map(block => block.markdown).join('\n\n') || 'No new output.' });
  };
  for (;;) {
    signal.throwIfAborted();
    if (!await api.isActive()) throw new Error('This Jevellan connection has expired or been revoked.');
    const page = AgentEventPageSchema.parse(await api.events(input.target, cursor.after, input.limit - collected.length, signal));
    if (page.events.length > input.limit - collected.length || page.events.some((event, index) => event.id !== cursor.after + index + 1) || page.nextCursor !== (page.events.at(-1)?.id ?? cursor.after)) {
      throw new Error('The output history changed unexpectedly. Read the target again before watching.');
    }
    state = page.state ?? state;
    const expired = Date.now() >= deadline;
    if (page.events.length) {
      const chunk = resultFor(page.events, cursor, page.hasMore, false);
      if (progress) await progress(chunk);
      collected.push(...page.events); cursor = decodeAgentCursor(chunk.cursor);
    }
    if (collected.length >= input.limit || expired || input.streamMs === 0 && (collected.length > 0 || input.waitMs === 0)) return resultFor(collected, initial, page.hasMore, expired && collected.length === 0 && Math.max(input.waitMs, input.streamMs) > 0);
    if (page.hasMore) continue;
    await wait(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}
