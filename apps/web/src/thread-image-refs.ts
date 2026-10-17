import type { CursorTurn, ThreadReport } from '@jevellan/core/client';

const image = /\.(?:png|jpe?g|gif|webp)$/iu;
/** File references only: never turn remote URLs or embedded credentials into browser requests. */
export function imageReferences(text: string, pathsOnly = false): string[] {
  text = text.split('\n').filter(line => !line.startsWith('Attached file: library/')).join('\n');
  const found = new Set<string>();
  const add = (value: string) => {
    try { value = decodeURIComponent(value); } catch { /* literal percent in a filename */ }
    value = value.trim().replace(/^<|>$/gu, '');
    if (!/(?:^|\/)library\/(?:uploads|outputs|[^/]+\/(?:uploads|outputs))\//u.test(value) && value.length <= 4096 && image.test(value) && !/^[a-z][a-z\d+.-]*:|[\n\r\0]/iu.test(value) && !/[${}]/u.test(value) && !value.split('/').includes('..')) found.add(value.replace(/^\.\//u, ''));
  };
  if (!pathsOnly && image.test(text.trim()) && !/[\n\r]/u.test(text)) add(text);
  // JSON path values preserve spaces (Read, view_image and browser screenshot tools).
  try {
    const visit = (value: unknown, depth: number) => {
      if (depth > 8 || value === null || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && /^(?:file_?path|path|filename|output_path)$/iu.test(key)) add(item);
        else if (typeof item === 'object') visit(item, depth + 1);
      }
    };
    visit(JSON.parse(text), 0);
  } catch { /* prose and tool output */ }
  if (pathsOnly) return [...found].slice(0, 200);
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(<?([^\n]*?\.(?:png|jpe?g|gif|webp))>?(?:\s+"[^"]*")?\)/giu)) add(match[1]!);
  for (const match of text.matchAll(/[`"]([^`"\n]+\.(?:png|jpe?g|gif|webp))[`"]/giu)) add(match[1]!);
  for (const match of text.matchAll(/(?:^|[\s(])((?:\.?\.?\/|\/)?[\w.@-]+(?:\/[\w.@%+-]+)*\.(?:png|jpe?g|gif|webp))(?=$|[\s),.;])/giu)) add(match[1]!);
  return [...found].slice(0, 200);
}
export function turnImages(turn: CursorTurn): string[] {
  return [...new Set(turn.blocks.flatMap(block => block.type === 'tool' ? /jevellan_library_(?:list|get|add)$/u.test(block.name) ? [] : block.output === undefined && block.state !== 'completed' ? [] : [...imageReferences(block.input, true), ...imageReferences(block.output ?? '').filter(ref => ref.includes('/'))] : imageReferences(block.text)))];
}
export function sessionImages(turns: readonly CursorTurn[], reports: readonly ThreadReport[]): string[] {
  return [...new Set([...turns.flatMap(turnImages), ...reports.flatMap(report => imageReferences(report.summary))])].slice(0, 200);
}
