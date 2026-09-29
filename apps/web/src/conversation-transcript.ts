import type { CursorTurn, LedgerEvent } from '@jevellan/core/client';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function display(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try { return display(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value) && value.every(part => typeof record(part).text === 'string')) return value.map(part => record(part).text).join('\n');
  return JSON.stringify(value, null, 2);
}

/** Preserve ledger order while joining streamed deltas and pairing tool results. */
export function conversationTurns(events: LedgerEvent[], running: boolean): CursorTurn[] {
  const turns: CursorTurn[] = [];
  const tools = new Map<string, Extract<CursorTurn['blocks'][number], { type: 'tool' }>>();
  for (const event of events) {
    const data = record(event.data);
    if (event.type === 'text' || event.type === 'thinking') {
      const text = typeof data.delta === 'string' ? data.delta : '';
      if (!text) continue;
      const previous = turns.at(-1)?.blocks.at(-1);
      if (previous?.type === event.type) previous.text += text;
      else turns.push({ id: `ledger:${event.id}`, role: 'assistant', blocks: [{ type: event.type, text }] });
    } else if (event.type === 'tool-start') {
      const tool: Extract<CursorTurn['blocks'][number], { type: 'tool' }> = {
        type: 'tool', id: String(data.id ?? event.id), name: String(data.name ?? 'Tool'), input: display(data.input), state: running ? 'running' : 'unknown',
      };
      tools.set(tool.id, tool); turns.push({ id: `ledger:${event.id}`, role: 'assistant', blocks: [tool] });
    } else if (event.type === 'tool-end') {
      const tool = tools.get(String(data.id));
      if (tool) { tool.state = data.ok === false ? 'failed' : 'completed'; if (data.output !== undefined) tool.output = display(data.output); }
    }
  }
  return turns;
}
