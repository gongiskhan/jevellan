import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConversationEventSchema, queuedRefresh, STATUS_REFRESH_WINDOW_MS, type LedgerEvent } from '@jevellan/core';
import type { ConversationLedger } from '@jevellan/conversations';

import { publicConversationData } from '@jevellan/core';
export { publicConversationData } from '@jevellan/core';

/** A ledger an event stream follows: replay after a cursor, then a wake-up after every durable append. */
export type StreamedLedger<E extends { id: number }> = { lastId(): number; events(afterId?: number, limit?: number): E[]; subscribe(listener: () => void): () => void };
/** The SSE event name, the browser document for one event, and the two cursor refusals (answered 400 before any header). */
/** `skip`: events the stream's reader never shows; the cursor passes them without a frame. */
export type LedgerStreamFrame<E> = { name: string; payload(event: E): unknown; invalidCursor: string; aheadCursor: string; skip?(event: E): boolean };
export type LedgerStatusView = { read(signal: AbortSignal): Promise<unknown> };

/**
 * Server-sent events over an append-only ledger: `Last-Event-ID`, else `?after=`, else 0 as the cursor; one frame per event
 * (`id: N`, `event: <name>`, `data: <payload>`); 64-event batches with backpressure; authentication checked again on every
 * flush; a keepalive comment every 15 s.
 */
export function streamLedger<E extends { id: number }>(ledger: StreamedLedger<E>, request: IncomingMessage, response: ServerResponse, url: URL, authenticated: () => boolean | Promise<boolean>, frame: LedgerStreamFrame<E>, statusView?: LedgerStatusView): void {
  const supplied = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
  if (typeof supplied !== 'string' || !/^\d+$/.test(supplied) || !Number.isSafeInteger(Number(supplied))) throw new Error(frame.invalidCursor);
  let cursor = Number(supplied);
  if (cursor > ledger.lastId()) throw new Error(frame.aheadCursor);
  let stopped = false; let pending = false; let paused = false; let flushing = false; let queued = false; let keepalive = false; let skipped = false;
  let statusHead = ledger.lastId();
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const statusFrames: unknown[] = [];
  let unsubscribe = () => {};
  const close = () => { if (stopped) return; stopped = true; unsubscribe(); status?.stop(); statusFrames.length = 0; clearTimeout(statusTimer); clearInterval(heartbeat); response.off('drain', drained); };
  const schedule = () => {
    queued = true;
    if (stopped || pending || paused || flushing) return;
    pending = true; setImmediate(() => { pending = false; void flush(); });
  };
  // View reads run independently of raw-event delivery. Replay uses the initial HTTP snapshot;
  // subsequent journal heads share the same serialized catch-up and cancellation policy as fallback reads.
  const status = statusView ? queuedRefresh(statusView.read, value => { statusFrames.push(value); schedule(); }, () => {}) : undefined;
  const drained = () => { paused = false; schedule(); };
  const write = (event: E) => {
    if (frame.skip?.(event)) { cursor = event.id; skipped = true; return true; }
    skipped = false; const payload = frame.payload(event);
    const accepted = response.write(`id: ${event.id}\nevent: ${frame.name}\ndata: ${JSON.stringify(payload)}\n\n`);
    cursor = event.id; return accepted;
  };
  const flush = async () => {
    if (stopped || paused || flushing) return;
    flushing = true; queued = false;
    try {
      const allowed = await authenticated(); if (stopped) return;
      if (!allowed) { close(); response.end(); return; }
      const batch = ledger.events(cursor, 64);
      for (const event of batch) { if (!write(event)) { paused = true; return; } }
      // Skipped events at the end of a batch: a cursor frame says how far the stream reached, so a reader waiting for the ledger's head stops waiting.
      if (skipped) { skipped = false; if (!response.write(`id: ${cursor}\nevent: cursor\ndata: ${JSON.stringify({ id: cursor })}\n\n`)) { paused = true; return; } }
      const head = ledger.lastId();
      if (status && cursor >= head && head > statusHead) {
        statusHead = head;
        if (!statusTimer) statusTimer = setTimeout(() => { statusTimer = undefined; void status.request(); }, STATUS_REFRESH_WINDOW_MS);
      }
      while (statusFrames.length) {
        const value = statusFrames.shift();
        if (!response.write(`event: status-view\ndata: ${JSON.stringify(value)}\n\n`)) { paused = true; return; }
      }
      if (keepalive) { keepalive = false; paused = !response.write(': keepalive\n\n'); }
      if (batch.length === 64) queued = true;
    } catch { close(); response.destroy(); }
    finally { flushing = false; if (queued && !stopped && !paused) schedule(); }
  };
  response.on('close', close); response.on('error', close); response.on('drain', drained);
  // Subscribe before replay. Each wake reads the journal from the accepted cursor.
  unsubscribe = ledger.subscribe(schedule);
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
    'X-Jevellan-Ledger-Head': String(ledger.lastId()) });
  response.flushHeaders();
  const heartbeat = setInterval(() => {
    keepalive = true; schedule();
  }, 15_000); heartbeat.unref();
  schedule();
}

export function streamConversation(ledger: ConversationLedger, request: IncomingMessage, response: ServerResponse, url: URL, authenticated: () => boolean | Promise<boolean>, statusView?: LedgerStatusView): void {
  streamLedger(ledger, request, response, url, authenticated, { name: 'conversation', invalidCursor: 'Invalid conversation event cursor.', aheadCursor: 'Conversation event cursor is ahead of its history.',
    payload: (event: LedgerEvent) => ConversationEventSchema.parse(ledger.redact({ schema: 'conversation-event-v1', event: { ...event, data: publicConversationData(ledger.data(event)) } })) }, statusView);
}
