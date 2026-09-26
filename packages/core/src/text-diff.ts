const MAX_CELLS = 4_000_000;

function lines(text: string | null): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}
type Operation = { kind: ' ' | '-' | '+'; text: string };
function operations(before: string[], after: string[]): Operation[] {
  let start = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0; while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const a = before.slice(start, before.length - end); const b = after.slice(start, after.length - end);
  const middle: Operation[] = [];
  if (a.length * b.length > MAX_CELLS) {
    // Very large notes fall back to one replacement block instead of an expensive table.
    middle.push(...a.map(text => ({ kind: '-' as const, text })), ...b.map(text => ({ kind: '+' as const, text })));
  } else {
    const width = b.length + 1; const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
    let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { middle.push({ kind: ' ', text: a[i]! }); i++; j++; }
      else if (i < a.length && (j === b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { middle.push({ kind: '-', text: a[i]! }); i++; }
      else { middle.push({ kind: '+', text: b[j]! }); j++; }
    }
  }
  return [...before.slice(0, start).map(text => ({ kind: ' ' as const, text })), ...middle, ...before.slice(before.length - end).map(text => ({ kind: ' ' as const, text }))];
}

/** A git-style unified diff of one text file; null means the file is absent on that side. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return '';
  const ops = operations(lines(before), lines(after));
  const header = [`diff --git a/${path} b/${path}`, ...(before === null ? ['new file mode 100644'] : after === null ? ['deleted file mode 100644'] : []),
    `--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  const changed = ops.flatMap((op, index) => op.kind === ' ' ? [] : [index]);
  const hunks: string[] = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const first = Math.max(0, changed[cursor]! - context); let last = changed[cursor]!;
    while (cursor + 1 < changed.length && changed[cursor + 1]! - last <= context * 2 + 1) last = changed[++cursor]!;
    last = Math.min(ops.length - 1, last + context); cursor++;
    const oldStart = ops.slice(0, first).filter(op => op.kind !== '+').length; const newStart = ops.slice(0, first).filter(op => op.kind !== '-').length;
    const body = ops.slice(first, last + 1);
    const oldCount = body.filter(op => op.kind !== '+').length; const newCount = body.filter(op => op.kind !== '-').length;
    hunks.push(`@@ -${oldCount ? oldStart + 1 : oldStart},${oldCount} +${newCount ? newStart + 1 : newStart},${newCount} @@`, ...body.map(op => `${op.kind}${op.text}`));
  }
  return `${[...header, ...hunks].join('\n')}\n`;
}
