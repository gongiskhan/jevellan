// Invoked by Cursor's desktop hook runner. No listener, CLI agent or native
// database write: Cursor itself receives hook responses over this process's stdout.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CursorHookPayloadSchema, CursorMessageSchema, Homes, writeDocument } from '@jevellan/core/cursor';
import { cursorSessionId } from './cursor-transcript.js';
import { cursorHookState, cursorMessages } from './cursor-reader.js';
import { cursorLock, cursorMessagePath, saveCursorHookState } from './cursor-control.js';
import { recordCursorActivity } from './cursor-activity.js';

const home = resolve(process.argv[2] ?? join(homedir(), '.jevellan'));
let replied = false;
function reply(value: object = {}) { if (!replied) { replied = true; process.stdout.write(JSON.stringify(value) + '\n'); } }
process.on('SIGTERM', () => { reply(); process.exit(0); });
process.on('SIGINT', () => { reply(); process.exit(0); });
async function main() {
  new Homes(home);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Hook input limit reached.'); chunks.push(Buffer.from(chunk)); }
  const payload = CursorHookPayloadSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const id = cursorSessionId(payload.conversation_id); const name = payload.hook_event_name;
  const generation = payload.generation_id ?? cursorHookState(home, id)?.generation ?? '';
  const now = () => new Date().toISOString();
  const stop = name === 'stop' || name === 'sessionEnd';
  const canHold = name === 'stop' && payload.status === 'completed';
  const until = new Date(Date.now() + 7 * 60 * 60_000).toISOString();
  cursorLock(home, id, () => {
    const old = cursorHookState(home, id);
    // A delayed hook from an earlier turn cannot overwrite the new turn.
    if (old && generation && old.generation && generation !== old.generation && name !== 'beforeSubmitPrompt' && name !== 'sessionStart') return;
    const state = saveCursorHookState(home, {
      schema: 'cursor-hook-state-v1', id, nativeId: payload.conversation_id,
      generation: generation || old?.generation || '', cwd: payload.workspace_roots?.[0] ?? old?.cwd ?? null,
      title: old?.title || payload.prompt?.replace(/\s+/g, ' ').slice(0, 120) || 'Cursor conversation',
      state: stop ? 'idle' : 'working', at: now(),
      hold: canHold ? { pid: process.pid, generation: generation || old?.generation || '', until } : null,
    });
    // Observation failures must not interfere with delivery or Cursor's work.
    try { recordCursorActivity(home, id, state.generation, payload); } catch { /* State and delivery remain available. */ }
    for (const message of cursorMessages(home, id)) if (message.state === 'queued' &&
      (message.generation !== state.generation || (stop && message.mode === 'steer') || name === 'sessionEnd' || (name === 'stop' && !canHold)))
      writeDocument(cursorMessagePath(home, id, message.clientMessageId), CursorMessageSchema, { ...message, state: 'expired' });
  });
  const take = (mode: 'steer' | 'next') => cursorLock(home, id, () => {
    const current = cursorHookState(home, id);
    if (!current || current.generation !== generation || (mode === 'next' && current.hold?.pid !== process.pid)) return null;
    const message = cursorMessages(home, id).find(message => message.state === 'queued' && message.mode === mode && message.generation === generation);
    if (!message) return null;
    // Persist the handoff before stdout. A crash must never resend a prompt.
    writeDocument(cursorMessagePath(home, id, message.clientMessageId), CursorMessageSchema, { ...message, state: 'handed-to-cursor' });
    if (mode === 'next') saveCursorHookState(home, { ...current, hold: null });
    return message.text;
  });
  if (name === 'postToolUse' || name === 'postToolUseFailure') {
    const message = take('steer'); reply(message ? { additional_context: `The user sent this steering message through Jevellan:\n\n${message}` } : {});
  } else if (canHold) {
    while (Date.now() < Date.parse(until)) {
      const current = cursorHookState(home, id);
      if (current?.hold?.pid !== process.pid) break;
      let message: string | null = null;
      // The queue writer can briefly own the lock. Keep the stop hook available
      // rather than releasing the session because of that transient contention.
      try { message = take('next'); } catch { /* Try again while this hold is current. */ }
      if (message) { reply({ followup_message: message }); return; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    cursorLock(home, id, () => { const current = cursorHookState(home, id); if (current?.hold?.pid === process.pid) saveCursorHookState(home, { ...current, hold: null }); });
    reply();
  } else reply();
}
try { await main(); } catch { reply(); }
