import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';

async function fixturePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const listeners: Server[] = [];
    try {
      const first = createServer(); listeners.push(first); await new Promise<void>((resolve, reject) => { first.once('error', reject); first.listen(0, '127.0.0.1', resolve); });
      const port = (first.address() as { port: number }).port; if (port > 65335) continue;
      for (const offset of [100, 200]) { const next = createServer(); listeners.push(next); await new Promise<void>((resolve, reject) => { next.once('error', reject); next.listen(port + offset, '127.0.0.1', resolve); }); }
      return port;
    } catch { /* Retry a free three-listener range, preserving occupied ports. */ }
    finally { await Promise.all(listeners.map(server => new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); }))); }
  }
  throw new Error('No browser fixture port range is free.');
}

test('ordinary browser fixtures signal ready only through the listener bound after all member and account seeding', { timeout: 120_000 }, async () => {
  const port = await fixturePort();
  const child = spawn(process.execPath, ['scripts/test-server.mjs', '--port', String(port)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 55_000; let response: Response | undefined;
    while (!response && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('The browser fixture stopped during startup.');
      try { response = await fetch(`http://127.0.0.1:${port + 200}/ready`, { signal: AbortSignal.timeout(1_000) }); }
      catch { await delay(100); }
    }
    expect(response?.status, 'the after-seeding readiness route must answer 204').toBe(204);
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' }), signal: AbortSignal.timeout(15_000) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const roster = await fetch(`http://127.0.0.1:${port}/hub/devices/roster`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) });
    expect(roster.status).toBe(200);
    const view = await roster.json() as { devices: Array<{ device: { name: string } }> };
    expect(view.devices.some(row => row.device.name === 'Browser member')).toBe(true);
  } finally {
    child.kill('SIGTERM');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The owned browser fixture did not stop.')), 40_000); })]); }
    finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
});
