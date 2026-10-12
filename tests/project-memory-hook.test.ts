import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

test.each(['PreCompact', 'Stop', 'SessionEnd'])('the %s hook forwards its session and journal without copying transcript data into the request', async event => {
  let received: unknown;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString()); response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ schema: 'bridge-result-v1', result: { queued: true } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', "import {serveMemoryHook} from './packages/cli/dist/memory-hook.js'; await serveMemoryHook();"], {
      env: { ...process.env, JEVELLAN_DAEMON_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, JEVELLAN_STRETCH_TOKEN: 'fixture-hook-token' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'fixture-hook-session', transcript_path: '/isolated/account/fixture.jsonl', irrelevant: 'native payload' }));
    expect(await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); })).toBe(0);
    expect(stdout.trim()).toBe('{}'); expect(received).toEqual({ schema: 'bridge-request-v1', operation: 'memory-capture', event, sessionId: 'fixture-hook-session', transcriptPath: '/isolated/account/fixture.jsonl' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
