import { z } from 'zod';
import { BridgeRequestSchema, BridgeResultSchema, MemoryHookEventSchema } from '@jevellan/core/client';

const PayloadSchema = z.object({ hook_event_name: MemoryHookEventSchema });

/** Bounded, advisory hook. It sends no provider-authored content and writes no files. */
export async function serveMemoryHook(): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => { abort.abort(); process.stdin.destroy(); }, 2000);
  try {
    const token = process.env.JEVELLAN_STRETCH_TOKEN; const address = process.env.JEVELLAN_DAEMON_URL;
    if (!token || !address) return;
    const base = new URL(address);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid owner');
    const chunks: Buffer[] = []; let size = 0;
    for await (const value of process.stdin) {
      const chunk = Buffer.from(value as Uint8Array); size += chunk.length;
      if (size > 65_536) throw new Error('Oversized input');
      chunks.push(chunk);
    }
    abort.signal.throwIfAborted();
    const payload = PayloadSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const request = BridgeRequestSchema.parse({ schema: 'bridge-request-v1', operation: 'memory-capture', event: payload.hook_event_name });
    const response = await fetch(new URL('/api/bridge', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(request), redirect: 'error', signal: abort.signal });
    if (!response.ok) throw new Error('Queue refused');
    BridgeResultSchema.parse(await response.json());
  } catch {
    // Provider payloads and errors may contain secrets. Never echo either.
    process.stderr.write('Project memory capture was not queued.\n');
  } finally {
    clearTimeout(timer); process.stdin.destroy();
    // Stop hooks require JSON; no decision or context is returned to the model.
    process.stdout.write('{}\n');
  }
}
