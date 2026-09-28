import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CursorTurnSchema, type CursorTurn } from '@jevellan/core';

const NativeRecord = z.object({
  role: z.string().optional(), type: z.string().optional(),
  message: z.object({ content: z.unknown() }).optional(),
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
export const cursorSessionId = (nativeId: string) => `cursor_${createHash('sha256').update(nativeId).digest('hex').slice(0, 32)}`;
export const cursorUserText = (value: string) => value.replace(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/, '$1');

/** Preserve markdown and message boundaries; fold tool results into their call. */
export function parseCursorTranscript(raw: string, format: 'jsonl' | 'text', offset = 0): {
  turns: CursorTurn[]; completed: boolean; active: boolean;
} {
  const turns: CursorTurn[] = [];
  const tools = new Map<string, Extract<CursorTurn['blocks'][number], { type: 'tool' }>>();
  let completed = false; let active = false;
  if (format === 'text') {
    const headings = [...raw.matchAll(/^(user|assistant):\s*$/gm)];
    if (!headings.length && raw.trim()) turns.push({ id: `text:${offset}`, role: 'assistant', blocks: [{ type: 'text', text: raw }] });
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]!;
      const content = raw.slice(heading.index! + heading[0].length, headings[i + 1]?.index ?? raw.length).trim();
      if (content) turns.push({ id: `text:${offset + heading.index!}`, role: heading[1] as 'user' | 'assistant', blocks: [{ type: 'text', text: cursorUserText(content) }] });
    }
    return { turns, completed, active };
  }
  let byte = offset;
  for (const line of raw.split('\n')) {
    const id = `line:${byte}`; byte += Buffer.byteLength(line) + 1;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const parsed = NativeRecord.safeParse(value); if (!parsed.success) continue;
    const row = parsed.data;
    if (row.type === 'turn_ended') { completed = true; active = false; continue; }
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    completed = false; active = true;
    const parts = row.message?.content;
    const blocks: CursorTurn['blocks'] = [];
    for (const part of typeof parts === 'string' ? [{ type: 'text', text: parts }] : Array.isArray(parts) ? parts : []) {
      const block = object(part);
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        blocks.push({ type: 'text', text: row.role === 'user' ? cursorUserText(block.text) : block.text });
      } else if (block.type === 'thinking' && typeof (block.thinking ?? block.text) === 'string') {
        blocks.push({ type: 'thinking', text: String(block.thinking ?? block.text) });
      } else if (block.type === 'tool_use') {
        const tool: Extract<CursorTurn['blocks'][number], { type: 'tool' }> = {
          type: 'tool', id: typeof block.id === 'string' ? block.id : `${id}:${blocks.length}`,
          name: typeof block.name === 'string' ? block.name : 'Tool', input: text(block.input), state: 'running',
        };
        tools.set(tool.id, tool); blocks.push(tool);
      } else if (block.type === 'tool_result') {
        const output = Array.isArray(block.content)
          ? block.content.map(part => object(part)).filter(part => part.type === 'text').map(part => text(part.text)).join('\n')
          : text(block.content);
        const existing = tools.get(String(block.tool_use_id));
        if (existing) { existing.output = output; existing.state = block.is_error ? 'failed' : 'completed'; }
        else blocks.push({ type: 'tool', id: String(block.tool_use_id ?? id), name: 'Tool result', input: '', output, state: block.is_error ? 'failed' : 'completed' });
      }
    }
    if (blocks.length) turns.push({ id, role: blocks.every(block => block.type === 'tool') ? 'assistant' : row.role, blocks });
  }
  if (completed) for (const tool of tools.values()) if (tool.state === 'running') tool.state = 'unknown';
  return { turns: turns.map(turn => CursorTurnSchema.parse(turn)), completed, active };
}
