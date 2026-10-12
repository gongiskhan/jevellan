import { join } from 'node:path';
import { applicationRoot } from './app-paths.js';

export const PROJECT_MEMORY_ID = 'builtin_project_memory';
export const PROJECT_MEMORY_DESCRIPTION = JSON.stringify({
  schema: 'project-memory-hook-v1',
  description: 'Queues incremental, secret-redacted project transcript capture at compaction and session end. Projects sessions also capture at each turn end; extraction keeps durable knowledge in shared memory.',
}, null, 2);

/** Stable account configuration; the launch supplies the scoped token in its environment. */
export function projectMemoryHooks(executable = process.execPath, entry = join(applicationRoot(), 'bin', 'jevellan.mjs')) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(executable)} ${quote(entry)} memory-hook`;
  return { hooks: Object.fromEntries(['PreCompact', 'Stop', 'SessionEnd'].map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: 3 }] }]])) };
}
