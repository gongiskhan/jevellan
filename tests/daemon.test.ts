import { afterEach, expect, test } from 'vitest';
import { createDaemon } from '../apps/daemon/dist/index.js';
import { HealthSchema } from '../packages/core/dist/index.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
async function listen() {
  const server = createDaemon(); servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
test('daemon health responds without starting work', async () => {
  const url = await listen();
  const response = await fetch(`${url}/api/health`);
  expect(response.status).toBe(200);
  expect(HealthSchema.parse(await response.json()).status).toBe('ok');
});
test('unknown APIs and mutating health requests are refused', async () => {
  const url = await listen();
  expect((await fetch(`${url}/api/unknown`)).status).toBe(404);
  expect((await fetch(`${url}/api/health`, { method: 'POST' })).status).toBe(404);
});
