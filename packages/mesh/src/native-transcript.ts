import { z } from 'zod';
import { CursorTurnSchema, type CursorTurn } from '@jevellan/core/cursor';
import { cursorDisplayValue } from './cursor-activity.js';
import { cursorUserText } from './cursor-transcript.js';

export type NativeRuntime = 'claude' | 'codex';
export const nativeObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const RecordSchema = z.object({ type: z.string().default('') }).catchall(z.unknown());
export function nativeRecords(raw: string, offset = 0) {
  const records: { id: string; value: z.infer<typeof RecordSchema> }[] = [];
  let byte = offset;
  for (const line of raw.split('\n')) {
    const id = `journal:${byte}`; byte += Buffer.byteLength(line) + 1;
    try { const value = RecordSchema.safeParse(JSON.parse(line)); if (value.success) records.push({ id, value: value.data }); } catch { /* Incomplete trailing writes are retried next poll. */ }
  }
  return records;
}
const partsText = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(nativeObject).map(p => ['image', 'input_image'].includes(String(p.type)) ? '[Image attachment]'
    : ['text', 'input_text', 'output_text', 'summary_text'].includes(String(p.type)) && typeof p.text === 'string' ? p.text : '').filter(Boolean).join('\n') : '';
const cleanUser = (text: string) => cursorUserText(text)
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, '')
  .replace(/^\s*## My request:\s*/i, '').trim();

/** Only public display fields are projected: no encrypted reasoning or native credentials. */
export function parseNativeTranscript(raw: string, runtime: NativeRuntime, offset = 0): CursorTurn[] {
  const turns: CursorTurn[] = [];
  const tools = new Map<string, Extract<CursorTurn['blocks'][number], { type: 'tool' }>>();
  const records = nativeRecords(raw, offset);
  const userEvents = runtime === 'codex' && records.some(({ value }) => value.type === 'event_msg' && nativeObject(value.payload).type === 'user_message');
  for (const { id, value: row } of records) {
    let role: 'user' | 'assistant' = 'assistant'; let automated = false;
    const blocks: CursorTurn['blocks'] = [];
    const addText = (value: string, thinking = false) => { if (value.trim()) blocks.push({ type: thinking ? 'thinking' : 'text', text: cursorDisplayValue(value) }); };
    const call = (key: unknown, name: unknown, input: unknown) => {
      const tool: Extract<CursorTurn['blocks'][number], { type: 'tool' }> = { type: 'tool', id: typeof key === 'string' ? key : id, name: typeof name === 'string' ? name : 'Tool', input: cursorDisplayValue(input ?? ''), state: 'unknown' };
      tools.set(tool.id, tool); blocks.push(tool);
    };
    const result = (key: unknown, output: unknown, failed: boolean) => {
      const text = partsText(output) || cursorDisplayValue(output ?? '');
      const tool = tools.get(String(key));
      if (tool) { tool.output = cursorDisplayValue(text); tool.state = failed ? 'failed' : 'completed'; }
      else blocks.push({ type: 'tool', id: String(key ?? id), name: 'Tool result', input: '', output: cursorDisplayValue(text), state: failed ? 'failed' : 'completed' });
    };
    if (runtime === 'claude') {
      if (!['user', 'assistant'].includes(row.type) || row.isSidechain === true) continue;
      role = row.type as 'user' | 'assistant'; automated = row.isMeta === true;
      const content = nativeObject(row.message).content;
      for (const value of typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []) {
        const part = nativeObject(value);
        if (part.type === 'text' && typeof part.text === 'string') addText(role === 'user' ? cleanUser(part.text) : part.text);
        else if (part.type === 'thinking') addText(String(part.thinking ?? part.text ?? ''), true);
        else if (part.type === 'tool_use') call(part.id, part.name, part.input);
        else if (part.type === 'tool_result') result(part.tool_use_id, part.content, part.is_error === true);
        else if (part.type === 'image') addText('[Image attachment]');
      }
    } else {
      const part = nativeObject(row.payload);
      if (row.type === 'event_msg' && part.type === 'user_message') {
        role = 'user'; addText(cleanUser(typeof part.message === 'string' ? part.message : ''));
      } else if (row.type !== 'response_item') continue;
      else if (part.type === 'message') {
        if (part.role !== 'user' && part.role !== 'assistant' || part.role === 'user' && userEvents) continue;
        role = part.role as 'user' | 'assistant';
        const text = partsText(part.content); addText(role === 'user' ? cleanUser(text) : text);
      } else if (part.type === 'reasoning') addText(partsText(part.summary) || partsText(part.content), true);
      else if (part.type === 'function_call' || part.type === 'custom_tool_call') call(part.call_id ?? part.id, part.name, part.arguments ?? part.input);
      else if (part.type === 'function_call_output' || part.type === 'custom_tool_call_output') result(part.call_id, part.output, part.is_error === true);
    }
    if (blocks.length) turns.push({ id, role: blocks.every(block => block.type === 'tool') ? 'assistant' : role, blocks, ...(automated ? { automated: true } : {}) });
  }
  return turns.map(turn => CursorTurnSchema.parse(turn));
}

/** Garrison's bounded journal event baseline, including quiet unfinished turns. */
export function nativeActivity(raw: string, runtime: NativeRuntime, modified: number, now = Date.now()): 'working' | 'idle' | 'unknown' {
  let state: 'working' | 'idle' | 'text' | undefined;
  let at = modified;
  for (const { value: row } of nativeRecords(raw)) {
    const part = nativeObject(row.payload); const message = nativeObject(row.message);
    let next: typeof state;
    if (runtime === 'codex') {
      if (row.type === 'event_msg') {
        if (['task_started', 'user_message'].includes(String(part.type))) next = 'working';
        if (['task_complete', 'turn_aborted', 'turn_complete', 'shutdown'].includes(String(part.type))) next = 'idle';
      } else if (row.type === 'response_item') {
        if (part.type === 'message' && part.role === 'user' || ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning'].includes(String(part.type))) next = 'working';
        if (part.type === 'message' && part.role === 'assistant' && part.channel === 'final') next = 'idle';
      }
    } else {
      if (row.type === 'user' && row.isMeta !== true) next = /^\s*<command-name>\s*\/clear\s*<\/command-name>/.test(partsText(message.content)) ? 'idle' : 'working';
      if (row.type === 'assistant') next = ['end_turn', 'stop_sequence'].includes(String(message.stop_reason)) ? 'idle'
        : message.stop_reason == null && Array.isArray(message.content) && message.content.length > 0 && message.content.every(value => nativeObject(value).type === 'text') ? 'text' : 'working';
      if (row.type === 'system' && row.subtype === 'turn_duration') next = 'idle';
    }
    if (next) { state = next; const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN; if (Number.isFinite(time)) at = time; }
  }
  if (state === 'text') state = now - at > 5000 ? 'idle' : 'working';
  if (state === 'working' && now - modified > 6 * 60 * 60_000) return 'unknown';
  return state ?? (now - modified <= 20_000 ? 'working' : 'unknown');
}
