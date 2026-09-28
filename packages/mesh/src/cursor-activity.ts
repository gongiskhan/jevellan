import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CursorActivitySchema, CursorHookPayloadSchema, readDocument, writeDocument, type CursorTurn } from '@jevellan/core/cursor';

const path = (home: string, id: string) => join(home, 'cursor', id, 'activity.json');
export function cursorActivity(home: string, id: string) {
  return existsSync(path(home, id)) ? readDocument(path(home, id), CursorActivitySchema) : null;
}
export function cursorDisplayValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { /* Plain text output. */ } }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 32_000 ? `${text.slice(0, 32_000)}\n… Output truncated.` : text;
}
/** Called inside the session lock; captures only documented display fields. */
export function recordCursorActivity(home: string, id: string, generation: string, payload: z.infer<typeof CursorHookPayloadSchema>) {
  const previous = cursorActivity(home, id);
  const turns = previous?.generation === generation ? previous.turns : [];
  const event = payload.hook_event_name;
  let turn: CursorTurn | undefined;
  if (event === 'postToolUse' || event === 'postToolUseFailure') {
    const key = createHash('sha256').update(`${generation}:${payload.tool_use_id ?? randomUUID()}`).digest('hex').slice(0, 24);
    turn = { id: `hook:${key}`, role: 'assistant', blocks: [{ type: 'tool', id: key, name: payload.tool_name || 'Tool',
      input: cursorDisplayValue(payload.tool_input), output: cursorDisplayValue(payload.error_message ?? payload.tool_output), state: event === 'postToolUseFailure' ? 'failed' : 'completed' }] };
  } else if ((event === 'afterAgentResponse' || event === 'afterAgentThought') && payload.text) {
    turn = { id: `hook:${randomUUID()}`, role: 'assistant', blocks: [{ type: event === 'afterAgentThought' ? 'thinking' : 'text', text: cursorDisplayValue(payload.text) }] };
  }
  if (!turn && event !== 'beforeSubmitPrompt') return;
  if (turn) {
    const index = turns.findIndex(row => row.id === turn.id);
    if (index >= 0) turns[index] = turn; else turns.push(turn);
  }
  while (turns.length > 40 || JSON.stringify(turns).length > 256_000) turns.shift();
  writeDocument(path(home, id), CursorActivitySchema, { schema: 'cursor-activity-v1', generation, turns, observedAt: new Date().toISOString() });
}
