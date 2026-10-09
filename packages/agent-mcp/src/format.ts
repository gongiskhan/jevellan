import { AgentOutputBlockSchema, type AgentOutputBlock, type AgentOutputEvent, type AgentWatchCursor } from './schemas.js';

const code = (value: string) => {
  const longest = Math.max(2, ...[...value.matchAll(/`+/gu)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${value}\n${fence}`;
};
const heading = (value: string) => value.replace(/[\r\n]/gu, ' ');

/** The stable IDs and replace/offset fields let richer clients update one area while Markdown stays readable. */
export function outputBlocks(events: readonly AgentOutputEvent[], initial?: AgentWatchCursor['group']): { blocks: AgentOutputBlock[]; group?: AgentWatchCursor['group'] } {
  const blocks: AgentOutputBlock[] = [];
  let last = initial;
  for (const event of events) {
    const type = event.kind === 'tool' ? 'tools' : event.kind;
    const same = last?.type === type && last.turnId === event.turnId && (type !== 'tools' || last.toolName === event.toolName);
    const id = event.groupId ?? (same ? last!.id : event.blockId);
    let block = blocks.find(candidate => candidate.id === id);
    if (!block) {
      block = { id, type, ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
        continuation: initial?.id === id || event.replace === true || (event.offset ?? 0) > 0, events: [], markdown: '' };
      blocks.push(block);
    }
    block.events.push(event);
    last = { id, type, ...(event.toolName === undefined ? {} : { toolName: event.toolName }), ...(event.turnId === undefined ? {} : { turnId: event.turnId }) };
  }
  for (const block of blocks) { block.markdown = blockMarkdown(block); AgentOutputBlockSchema.parse(block); }
  return { blocks, ...(last === undefined ? {} : { group: last }) };
}

function blockMarkdown(block: AgentOutputBlock): string {
  if (block.type === 'text' || block.type === 'thinking') {
    const values = new Map<string, string>();
    for (const event of block.events) values.set(event.blockId, event.replace ? event.text ?? '' : (values.get(event.blockId) ?? '') + (event.text ?? ''));
    const text = [...values.values()].join('');
    return block.type === 'thinking' ? `### Thinking\n\n${text}` : block.events[0]?.role === 'user' ? `### You\n\n${text}` : text;
  }
  if (block.type === 'tools') {
    const calls = new Map<string, AgentOutputEvent>();
    for (const event of block.events) calls.set(event.blockId, { ...calls.get(event.blockId), ...event });
    const entries = [...calls.values()].map(event => {
      const parts: string[] = [];
      if (event.input !== undefined) parts.push(`Input\n\n${code(event.input)}`);
      if (event.output !== undefined) parts.push(`Output\n\n${code(event.output)}`);
      if (event.state !== undefined) parts.push(`Status: ${heading(event.state)}`);
      return parts.join('\n\n');
    });
    return `### ${heading(block.toolName ?? 'Tool')}${block.continuation ? ' (continued)' : ''}\n\n${entries.join('\n\n')}`;
  }
  const label = block.type[0]!.toUpperCase() + block.type.slice(1);
  return `### ${label}\n\n${block.events.map(event => event.text ?? (event.data === undefined ? '' : code(JSON.stringify(event.data, null, 2)))).join('\n\n')}`;
}

export function formatAgentDocument(operation: string, data: unknown): string {
  const label = heading(operation.replaceAll('_', ' '));
  if (data === null || data === undefined) return `### ${label}\n\nNo data.`;
  if (typeof data === 'string') return `### ${label}\n\n${data}`;
  return `### ${label}\n\n${code(JSON.stringify(data, null, 2))}`;
}
