import { expect, test } from 'vitest';
import { GitHubClient } from '../packages/core/dist/index.js';

const repository = { owner: 'fixture', repo: 'repo' };
const base = 'https://api.github.com/repos/fixture/repo';
const json = (value: unknown, status = 200) => Response.json(value, { status });
function fixture(options: { logStatus?: number; jobStatus?: number; checkUrl?: string | null; annotationsStatus?: number; message?: string } = {}) {
  const requests: string[] = [], token = 'fixture-private-token';
  const client = new GitHubClient({ token: async () => token, fetch: async (input) => {
    const url = String(input); requests.push(url);
    if (url === `${base}/actions/jobs/7/logs`) return json({ message: 'Not Found' }, options.logStatus ?? 404);
    if (url === `${base}/actions/jobs/7`) return json({ id: 7, run_id: 8, name: 'result', status: 'completed', conclusion: 'failure',
      check_run_url: options.checkUrl === undefined ? `${base}/check-runs/99` : options.checkUrl }, options.jobStatus ?? 200);
    if (url === `${base}/check-runs/99`) return json({ output: { title: null, summary: null, text: null } });
    if (url === `${base}/check-runs/99/annotations?per_page=100`) return options.annotationsStatus ? json({ message: 'Resource not accessible' }, options.annotationsStatus)
      : json([{ annotation_level: 'failure', title: '', message: options.message ?? 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' }]);
    throw new Error(`Unexpected request: ${url}`);
  } });
  return { client, requests, token };
}

test('a missing log returns the actual startup failure from the job’s check annotations', async () => {
  const f = fixture(), output = await f.client.workflowJobLog(repository, 7);
  expect(output).toContain('No downloadable log is available for job 7');
  expect(output).toContain('result: completed (failure)');
  expect(output).toContain('recent account payments have failed');
  expect(f.requests).toEqual([`${base}/actions/jobs/7/logs`, `${base}/actions/jobs/7`, `${base}/check-runs/99`, `${base}/check-runs/99/annotations?per_page=100`]);
});

test('ordinary logs keep their single-request fast path', async () => {
  let calls = 0;
  const client = new GitHubClient({ token: async () => 'fixture-token', fetch: async () => { calls++; return new Response('test failed'); } });
  expect(await client.workflowJobLog(repository, 7)).toBe('test failed'); expect(calls).toBe(1);
});

test('a missing blob after GitHub’s signed redirect uses the same diagnosis without forwarding credentials', async () => {
  const f = fixture(), seen: Array<{ url: string; authorized: boolean }> = [];
  const client = new GitHubClient({ token: async () => f.token, fetch: async (input, init) => {
    const url = String(input); seen.push({ url, authorized: new Headers(init?.headers).has('Authorization') });
    if (url.endsWith('/logs')) return new Response(null, { status: 302, headers: { location: 'https://logs.blob.core.windows.net/log-missing' } });
    if (url.includes('.blob.core.windows.net/')) return new Response('<Error><Code>BlobNotFound</Code></Error>', { status: 404 });
    if (url.endsWith('/actions/jobs/7')) return json({ name: 'result', status: 'completed', conclusion: 'failure', check_run_url: null });
    throw new Error('Unexpected request');
  } });
  expect(await client.workflowJobLog(repository, 7)).toContain('No downloadable log');
  expect(seen.map(call => call.authorized)).toEqual([true, false, true]);
});

test('log authentication failures and missing jobs remain errors', async () => {
  for (const status of [401, 403, 500]) {
    const f = fixture({ logStatus: status }); await expect(f.client.workflowJobLog(repository, 7)).rejects.toMatchObject({ status });
    expect(f.requests).toHaveLength(1);
  }
  const f = fixture({ jobStatus: 404 }); await expect(f.client.workflowJobLog(repository, 7)).rejects.toMatchObject({ status: 404 });
  expect(f.requests).toHaveLength(2);
});

test('a logless job without a check link reports its status without inventing a diagnosis', async () => {
  const f = fixture({ checkUrl: null }); expect(await f.client.workflowJobLog(repository, 7)).toContain('No check annotations are available.');
  expect(f.requests).toHaveLength(2);
});

test('check links never send the token outside the configured API and repository', async () => {
  for (const checkUrl of ['https://evil.invalid/check-runs/99', 'https://api.github.com/repos/other/repo/check-runs/99',
    `${base}/check-runs/99?secret=true`, `${base}/check-runs/99/../100`]) {
    const f = fixture({ checkUrl }); await expect(f.client.workflowJobLog(repository, 7)).rejects.toThrow('GitHub returned an unexpected response.');
    expect(f.requests).toHaveLength(2);
  }
});

test('annotation permission failures remain visible', async () => {
  const f = fixture({ annotationsStatus: 403 }); await expect(f.client.workflowJobLog(repository, 7)).rejects.toMatchObject({ status: 403 });
});

test('annotation fallback is bounded and redacts the credential', async () => {
  const f = fixture({ message: `fixture-private-token ${'x'.repeat(10000)}` }); const output = await f.client.workflowJobLog(repository, 7);
  expect(output).not.toContain(f.token); expect(output).toContain('[redacted]'); expect(output.length).toBeLessThanOrEqual(8000);
});
