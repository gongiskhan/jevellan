import { Homes, JournalRebuildReceiptSchema } from '@jevellan/core';
import { localRequest } from './local-request.js';

export async function journalCommand(args: string[], homes = new Homes()): Promise<void> {
  if (args.length !== 2 || args[0] !== 'rebuild' || !args[1]) throw new Error('Usage: jevellan journal rebuild project');
  const result = await localRequest(homes, '/api/local/journal/rebuild', { schema: 'project-journal-rebuild-v1', project: args[1] }, JournalRebuildReceiptSchema,
    { timeoutMs: 120000, unanswered: 'The running Jevellan daemon could not rebuild the journal.', tooLarge: 'The journal rebuild receipt exceeded its limit.', daemonErrors: true });
  console.log(`Project journal rebuilt at ${result.path} (${result.files} files).`);
}
