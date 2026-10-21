import { expect, test } from 'vitest';
import { OwnerEvents } from '../apps/daemon/dist/owner-events.js';

test('a thread state that repeats unchanged is shown once, then at most every five minutes; a change shows at once', () => {
  let deliver: (ledger: unknown, event: unknown) => void = () => undefined;
  const app = { projectWork: { ledgers: { subscribe: (listener: typeof deliver) => { deliver = listener; } } }, redactor: { text: (value: string) => value },
    ownerTools: { ids: { shortOf: () => 'T4' } } };
  const events = new OwnerEvents(app as never);
  const ledger = { projectId: 'project', threadId: 'thread_a', data: (event: { data: unknown }) => event.data };
  let id = 0; const start = Date.parse('2026-10-21T09:00:00Z');
  const state = (seconds: number, from: string, to: string, reason?: string) => deliver(ledger, { id: ++id, type: 'thread-state', t: new Date(start + seconds * 1000).toISOString(),
    data: { schema: 'thread-state-v1', from, to, ...(reason ? { reason } : {}), changed: ['state'] } });
  const waiting = 'Waiting for a free slot on this device.';
  for (let second = 0; second < 300; second += 5) state(second, 'idle', 'idle', waiting);
  state(300, 'idle', 'idle', waiting); state(305, 'idle', 'running');
  expect(events.since(0).map(event => `${(Date.parse(event.at) - start) / 1000} ${event.text}`)).toEqual([`0 idle to idle (${waiting})`, `300 idle to idle (${waiting})`, '305 idle to running']);
});
