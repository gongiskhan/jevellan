/** A digest never discards notebook or open questions. Only the index, then recent conversation, can shrink. */
export function coordinatorJournalDigest(fresh: string, path: string, index: string, cap = 60000): string {
  const heading = `\n\nProject journal: ${path}. INDEX.md follows. Read a thread, day or night file with your Read tool when you need detail; never guess about past work.\n\n`;
  let context = fresh, contents = index;
  if (context.length + heading.length + contents.length > cap) {
    const rows = contents.split('\n'), earlier = rows.indexOf('## Earlier');
    // INDEX has already grouped old days into weeks. Fold those lines before recent thread/day lines.
    if (earlier >= 0) rows.splice(earlier + 1, rows.length - earlier - 1, '- Earlier history → days/ and threads/ files');
    contents = rows.join('\n');
    for (let position = rows.length - 1; context.length + heading.length + contents.length > cap && position >= 0; position--) {
      if (rows[position]!.startsWith('  - ')) { rows.splice(position, 1); contents = rows.join('\n'); }
    }
    const recentAt = rows.indexOf('## Last 7 days');
    for (let position = rows.indexOf('## Earlier') - 1; context.length + heading.length + contents.length > cap && position > recentAt; position--) {
      rows.splice(position, 1); contents = rows.join('\n');
    }
  }
  if (context.length + heading.length + contents.length > cap) {
    const start = context.indexOf('Recent conversation with the owner:\n');
    if (start >= 0) {
      const memoryAt = context.indexOf('\n\nProject memory:', start);
      const suffix = memoryAt >= 0 ? context.slice(memoryAt) : '';
      const prefix = context.slice(0, start) + 'Recent conversation with the owner:\n';
      const budget = Math.max(0, cap - prefix.length - suffix.length - heading.length - contents.length);
      context = prefix + context.slice(start + 'Recent conversation with the owner:\n'.length, memoryAt >= 0 ? memoryAt : undefined).slice(-budget || Infinity) + suffix;
    }
  }
  if (context.length + heading.length + contents.length > cap) throw new Error('The notebook and open state exceed the coordinator digest allowance.');
  return context + heading + contents;
}

export function threadJournalExcerpt(text: string, path: string, tail = 20000): string {
  const start = text.indexOf('\n## Entries\n'), header = start >= 0 ? text.slice(0, start + '\n## Entries\n'.length) : '';
  const entries = text.slice(header.length);
  return entries.length <= tail ? text : `${header}\nEarlier entries: ${path}\n${entries.slice(-tail)}`;
}
