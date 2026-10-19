import { readFileSync } from 'node:fs';
import { Homes, IdSchema, OwnerViaSchema, ProjectSendRequestSchema, ProjectSendResultSchema, COORDINATOR_REPLY_TIMEOUT, newId } from '@jevellan/core';
import { localRequest } from './local-request.js';
import type { z } from 'zod';
const usage = 'Usage: jevellan project send <project> [--from <label>] [--wait [seconds]] [--json] [--id <clientMessageId>] [--] <text...>';
export function projectSendArguments(args: string[], stdin = () => readFileSync(0, 'utf8')) {
  if (args[0] !== 'send' || !args[1]) throw new Error(usage);
  const project = args[1]; if (project.length > 200) throw new Error('Use a project name or id of at most 200 characters.');
  const words: string[] = []; let via: string | undefined, waitSeconds = 0, json = false, id: string | undefined, literal = false;
  for (let n = 2; n < args.length; n++) {
    const arg = args[n]!;
    if (literal) words.push(arg);
    else if (arg === '--') literal = true;
    else if (arg === '--json') json = true;
    else if (arg === '--from') { const value = args[++n]; if (!value) throw new Error('--from needs a label.'); via = OwnerViaSchema.parse(value); }
    else if (arg === '--id') { const value = args[++n]; if (!value) throw new Error('--id needs a message id.'); id = IdSchema.parse(value); }
    else if (arg === '--wait') {
      waitSeconds = 600;
      if (args[n + 1] !== undefined && /^-?\d/u.test(args[n + 1]!)) { waitSeconds = Number(args[++n]); if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 3600) throw new Error('--wait accepts 1 to 3600 seconds.'); }
    } else if (arg.startsWith('--')) throw new Error(`Unknown project option: ${arg}`);
    else words.push(arg);
  }
  return { project, json, input: ProjectSendRequestSchema.parse({ schema: 'project-send-request-v1', clientMessageId: id ?? newId('cli'), text: words.length ? words.join(' ') : stdin(), ...(via ? { via } : {}), waitSeconds }) };
}
export async function projectCommand(args: string[], homes = new Homes(), request: typeof localRequest<z.infer<typeof ProjectSendResultSchema>> = localRequest, stdin?: () => string): Promise<number> {
  const { project, json, input } = projectSendArguments(args, stdin);
  const result = await request(homes, `/api/local/projects/${encodeURIComponent(project)}/coordinator/messages`, input, ProjectSendResultSchema,
    { timeoutMs: input.waitSeconds * 1000 + 45_000, maxBytes: 1024 * 1024, unanswered: 'The running Jevellan daemon could not send the message.', tooLarge: 'The coordinator reply is too large; read it in Jevellan.', daemonErrors: true });
  if (input.waitSeconds && result.turn === null) { console.error(COORDINATOR_REPLY_TIMEOUT); return 2; }
  if (json) console.log(JSON.stringify({ ok: true, projectId: result.projectId, turn: result.turn, reply: result.reply, at: result.at }));
  else console.log(result.reply ?? `Sent to ${result.projectId}.`);
  return 0;
}
