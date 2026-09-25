import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConversationEventSchema, type LedgerEvent } from '@jevellan/core';
import type { ConversationLedger } from '@jevellan/conversations';

/** Process identities are recovery data, never browser timeline content. */
export function publicConversationData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  if (data.schema === 'work-control-v1' && data.kind === 'native') return { schema: 'conversation-process-v1', stretch: data.n };
  if (data.schema === 'stretch-v2') { const copy = { ...data }; delete copy.native; return copy; }
  if (data.schema === 'stretch-finished-v1') return { ...data, stretch: publicConversationData(data.stretch) };
  if ('id' in data && 't' in data && 'type' in data && 'data' in data) return { ...data, data: publicConversationData(data.data) };
  return value;
}

export function streamConversation(ledger: ConversationLedger, request: IncomingMessage, response: ServerResponse, url: URL, authenticated: () => boolean | Promise<boolean>): void {
  const supplied = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
  if (typeof supplied !== 'string' || !/^\d+$/.test(supplied) || !Number.isSafeInteger(Number(supplied))) throw new Error('Invalid conversation event cursor.');
  let cursor = Number(supplied);
  if (cursor > (ledger.events().at(-1)?.id ?? 0)) throw new Error('Conversation event cursor is ahead of its history.');
  let stopped = false; let pending = false; let paused = false; let flushing = false; let queued = false; let keepalive = false;
  let unsubscribe = () => {};
  const close = () => { if (stopped) return; stopped = true; unsubscribe(); clearInterval(heartbeat); response.off('drain', drained); };
  const schedule = () => {
    queued = true;
    if (stopped || pending || paused || flushing) return;
    pending = true; setImmediate(() => { pending = false; void flush(); });
  };
  const drained = () => { paused = false; schedule(); };
  const write = (event: LedgerEvent) => {
    const payload = ConversationEventSchema.parse(ledger.redact({ schema: 'conversation-event-v1', event: { ...event, data: publicConversationData(ledger.data(event)) } }));
    const accepted = response.write(`id: ${event.id}\nevent: conversation\ndata: ${JSON.stringify(payload)}\n\n`);
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
      if (keepalive) { keepalive = false; paused = !response.write(': keepalive\n\n'); }
      if (batch.length === 64) queued = true;
    } catch { close(); response.destroy(); }
    finally { flushing = false; if (queued && !stopped && !paused) schedule(); }
  };
  response.on('close', close); response.on('error', close); response.on('drain', drained);
  // Subscribe before replay. Each wake reads the journal from the accepted cursor.
  unsubscribe = ledger.subscribe(schedule);
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  response.flushHeaders();
  const heartbeat = setInterval(() => {
    keepalive = true; schedule();
  }, 15_000); heartbeat.unref();
  schedule();
}
