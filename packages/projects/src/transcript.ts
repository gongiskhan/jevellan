import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { NATIVE_SESSION_UNAVAILABLE, listNativeSessions, readNativeTranscript, type NativeJournal, type NativeRuntime } from '@jevellan/mesh';
import { nativeFormat } from '@jevellan/runtime-contract';
import type { CursorTranscriptSchema, Homes, Thread } from '@jevellan/core';
import { tail } from './git.js';

export type CursorTranscript = z.infer<typeof CursorTranscriptSchema>;
type Cached = { sessionId: string; root: string; file: string; size: number; mtimeMs: number; transcript: CursorTranscript };
export const TRANSCRIPT_TAIL_CHARS = 8000;
const unavailable = () => Object.assign(new Error(NATIVE_SESSION_UNAVAILABLE), { status: 404 });

/** The assistant's text in a transcript, oldest first, as its last `max` characters (`jevellan_thread_read`). */
export function assistantText(transcript: CursorTranscript, max = TRANSCRIPT_TAIL_CHARS): string {
  return tail(transcript.turns.filter((turn) => turn.role === 'assistant')
    .flatMap((turn) => turn.blocks.flatMap((block) => block.type === 'text' && block.text.trim() ? [block.text.trim()] : [])).join('\n\n'), max);
}

/**
 * Thread transcripts from the native session in the thread's account home (D60): read in a worker thread, cached by
 * journal file, size and modification time, with one read in flight per thread so concurrent pollers share it. Failed
 * reads are not cached. The journal is located once by session id and then read through its file hint.
 */
export class ThreadTranscripts {
  readonly #cache = new Map<string, Cached>();
  readonly #inflight = new Map<string, Promise<CursorTranscript | null>>();
  readonly #homes: Homes; readonly #deviceId: string; readonly #deviceName: string; readonly #timeoutMs: number | undefined;
  readonly #format: (runtime: string) => NativeRuntime;
  constructor(o: { homes: Homes; deviceId: string; deviceName: string; format?: (runtime: string) => NativeRuntime; timeoutMs?: number }) {
    this.#homes = o.homes; this.#deviceId = o.deviceId; this.#deviceName = o.deviceName; this.#format = o.format ?? nativeFormat; this.#timeoutMs = o.timeoutMs;
  }
  /** Null when the thread has no session yet; a session missing on disk rejects with status 404. */
  read(thread: Thread, projectName: string): Promise<CursorTranscript | null> {
    const running = this.#inflight.get(thread.id); if (running) return running;
    const read = this.#read(thread, projectName).finally(() => { this.#inflight.delete(thread.id); });
    this.#inflight.set(thread.id, read);
    return read;
  }
  forget(threadId: string): void { this.#cache.delete(threadId); }
  /** The native sessions in the thread's account home, newest first, listed in the worker (phase 7 detach); none when the home is missing. */
  sessions(thread: Thread): Promise<NativeJournal[]> { return listNativeSessions({ runtime: this.#format(thread.placement.runtime), root: this.#root(thread) }, this.#timeout()); }
  #timeout(): { timeoutMs?: number } { return this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }; }
  /** The account home is read where it is; it is never created for a read. */
  #root(thread: Thread): string {
    const root = this.#homes.at('homes', thread.placement.runtime, thread.placement.accountId);
    if (root !== join(this.#homes.root, 'homes', thread.placement.runtime, thread.placement.accountId)) throw new Error('Account homes cannot alias another directory.');
    return root;
  }
  async #read(thread: Thread, projectName: string): Promise<CursorTranscript | null> {
    const sessionId = thread.nativeSessionId; if (!sessionId) return null;
    const runtime = this.#format(thread.placement.runtime); const timeout = this.#timeout(); const root = this.#root(thread);
    let cached = this.#cache.get(thread.id);
    if (cached && (cached.sessionId !== sessionId || cached.root !== root)) { this.#cache.delete(thread.id); cached = undefined; }
    let file = cached?.file; let info = file ? await stat(file).catch(() => undefined) : undefined;
    if (!file || !info) {
      file = (await listNativeSessions({ runtime, root }, timeout)).find((journal) => journal.nativeId === sessionId)?.file;
      info = file ? await stat(file).catch(() => undefined) : undefined;
      if (!file || !info) { this.#cache.delete(thread.id); throw unavailable(); }
    }
    if (cached && cached.file === file && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.transcript;
    const transcript = await readNativeTranscript({ runtime, root, sessionId, deviceId: this.#deviceId, deviceName: this.#deviceName, title: thread.title, project: projectName, file }, timeout);
    this.#cache.set(thread.id, { sessionId, root, file, size: info.size, mtimeMs: info.mtimeMs, transcript });
    return transcript;
  }
}
