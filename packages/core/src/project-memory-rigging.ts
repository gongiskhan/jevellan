import { join } from 'node:path';
import { applicationRoot } from './app-paths.js';

export const PROJECT_MEMORY_ID = 'builtin_project_memory';
export const PROJECT_MEMORY_DESCRIPTION = JSON.stringify({
  schema: 'project-memory-hook-v1',
  description: 'Queues a structural checkpoint for this project at compaction or step end. No transcripts are read. Answer-only replies and handoff repair do not create automatic notes. Recall comes from the stretch brief.',
}, null, 2);

/** Stable account configuration; the launch supplies the scoped token in its environment. */
export function projectMemoryHooks(executable = process.execPath, entry = join(applicationRoot(), 'bin', 'jevellan.mjs')) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(executable)} ${quote(entry)} memory-hook`;
  return { hooks: Object.fromEntries(['PreCompact', 'Stop', 'SessionEnd'].map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: 3 }] }]])) };
}
