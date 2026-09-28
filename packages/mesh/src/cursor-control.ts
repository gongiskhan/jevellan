import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  CursorHookStateSchema, CursorMessageInputSchema, CursorMessageSchema, writeDocument, readDocument,
} from '@jevellan/core';
import { cursorHookState, cursorMessages, cursorSource, type CursorReaderOptions } from './cursor-reader.js';

export function cursorLock<T>(home: string, id: string, run: () => T): T {
  const lock = join(home, 'cursor', id, 'control.lock'); mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      let gone = false;
      try { process.kill(pid, 0); } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (gone) { unlinkSync(lock); return cursorLock(home, id, run); }
    }
    throw new Error('Cursor is updating this session. Try again.');
  }
  try { writeFileSync(fd, String(process.pid)); return run(); }
  finally { closeSync(fd); unlinkSync(lock); }
}
export function cursorMessagePath(home: string, id: string, messageId: string) { return join(home, 'cursor', id, 'messages', `${messageId}.json`); }
export function queueCursorMessage(options: CursorReaderOptions, id: string, value: unknown) {
  const input = CursorMessageInputSchema.parse(value);
  // Discovery can wait on Cursor's database. Never hold the hook's tiny write
  // lock while scanning native history.
  const source = cursorSource(options, id); const observed = cursorHookState(options.home, id);
  return cursorLock(options.home, id, () => {
    const path = cursorMessagePath(options.home, id, input.clientMessageId);
    if (existsSync(path)) {
      const previous = readDocument(path, CursorMessageSchema);
      if (previous.mode !== input.mode || previous.text !== input.text) throw new Error('This message ID was already used for different text.');
      return previous;
    }
    const hook = cursorHookState(options.home, id);
    if (!hook || hook.generation !== observed?.generation || hook.at !== observed?.at || !(input.mode === 'steer' ? source.session.canSteer : source.session.canSend))
      throw new Error(input.mode === 'steer' ? 'This session cannot receive steering now. Connect the Cursor hooks and wait for a running turn.' : 'This session is not connected for messages. Connect the Cursor hooks and send one message in Cursor first.');
    if (cursorMessages(options.home, id).filter(message => message.state === 'queued').length >= 20) throw new Error('This session already has 20 queued messages.');
    return writeDocument(path, CursorMessageSchema, { ...input, schema: 'cursor-message-v1', sessionId: id, createdAt: new Date().toISOString(), state: 'queued', generation: hook.generation });
  });
}
export function cancelCursorMessage(options: CursorReaderOptions, id: string, messageId: string) {
  return cursorLock(options.home, id, () => {
    const path = cursorMessagePath(options.home, id, messageId); const message = readDocument(path, CursorMessageSchema);
    if (message.state !== 'queued') throw new Error('This message has already left the queue.');
    return writeDocument(path, CursorMessageSchema, { ...message, state: 'cancelled' });
  });
}
export function saveCursorHookState(home: string, state: unknown) {
  const parsed = CursorHookStateSchema.parse(state);
  return writeDocument(join(home, 'cursor', parsed.id, 'state.json'), CursorHookStateSchema, parsed);
}
