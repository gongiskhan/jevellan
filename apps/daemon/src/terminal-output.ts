import { TerminalAckSchema, TerminalSendRequestSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { terminalPlain } from './terminal-buffer.js';
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });

/** The existing canonical output delivery body, shared by the raw owner API and typed action facade. */
export async function sendTerminalOutput(app: Application, id: string, raw: unknown, token: string) {
  const service = app.terminals;
  const input = TerminalSendRequestSchema.parse(raw), snapshot = await service.snapshot(id, token), projectId = snapshot.session.projectId;
  if (!projectId) throw refuse('Choose a project terminal to send its output.', 400);
  let text: string;
  if (input.content === 'selection') { if (!input.selection) throw refuse('Select text to send.', 400); text = input.selection; }
  else text = snapshot.commands.slice(input.content === 'last' ? -1 : -5).map(row => `$ ${row.command}\n${row.output}\nExit code: ${row.exitCode ?? 'unknown'}`).join('\n\n');
  text = app.redactor.text(terminalPlain(text)).slice(-30000); if (!text.trim()) throw refuse('This terminal has no command output yet.', 400);
  if (input.target.kind === 'thread') {
    const thread = (await app.projectHub.thread(input.target.threadId))?.document;
    if (!thread || thread.projectId !== projectId || ['done', 'failed', 'stopped'].includes(thread.state)) throw refuse('Choose an active thread of this project.', 400);
  }
  await app.projectWork.terminalMessage(projectId, input.target.kind === 'thread' ? { threadId: input.target.threadId } : { coordinator: true },
    `The owner sent output from the terminal on ${(await service.device(snapshot.session.deviceId)).name} in ${snapshot.session.cwd}:\n${text}`, input.clientMessageId);
  return TerminalAckSchema.parse({ schema: 'terminal-ack-v1', ok: true });
}
