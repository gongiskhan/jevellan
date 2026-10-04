import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, GitHubError, SecretRedactor, mapChecks, mapMergeable, parseGitHubRemote, type GitHubRepository } from '../packages/core/dist/index.js';
import { startGitHubFixture, type GitHubFixture, type GitHubFixtureChecks } from './fixtures/github-server.mjs';

let root: string; let origin: string; let work: string; let token: string; let github: GitHubFixture; let client: GitHubClient;
const repository: GitHubRepository = { owner: 'fixture', repo: 'repo' };
const branch = 'jv/feature-abcdef';
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const failure = async (promise: Promise<unknown>): Promise<GitHubError> => {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(GitHubError);
  return error as GitHubError;
};
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-github-')));
  origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin);
  work = join(root, 'work'); git(root, 'clone', origin, work);
  writeFileSync(join(work, 'value.txt'), '1\n'); git(work, 'add', '-A'); git(work, 'commit', '-m', 'Seed'); git(work, 'push', '-u', 'origin', 'main');
  git(work, 'switch', '-c', branch); writeFileSync(join(work, 'value.txt'), '2\n'); git(work, 'commit', '-am', 'Change'); git(work, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  token = `fixture-${randomUUID()}`;
  github = await startGitHubFixture({ token, repositories: { 'fixture/repo': origin } });
  client = new GitHubClient({ token: async () => token, baseUrl: github.url });
});
afterEach(async () => { vi.useRealTimers(); await github.close(); rmSync(root, { recursive: true, force: true }); });

test('parseGitHubRemote reads https, scp-like and ssh GitHub remotes and refuses everything else', () => {
  for (const url of ['https://github.com/Fixture/Repo', 'https://github.com/Fixture/Repo.git', 'https://github.com/Fixture/Repo/', 'https://github.com/Fixture/Repo.git/',
    'git@github.com:Fixture/Repo.git', 'git@github.com:Fixture/Repo', 'ssh://git@github.com/Fixture/Repo.git', 'ssh://git@github.com/Fixture/Repo', ' https://github.com/Fixture/Repo.git\n']) {
    expect(parseGitHubRemote(url), url).toEqual({ owner: 'Fixture', repo: 'Repo' });
  }
  expect(parseGitHubRemote('https://github.com/o/my.repo_x-1.git')).toEqual({ owner: 'o', repo: 'my.repo_x-1' });
  for (const url of ['', 'https://gitlab.com/o/r.git', 'http://github.com/o/r.git', 'https://github.com/o', 'https://github.com/o/r/pulls', 'https://github.com.example.com/o/r',
    'https://user:secret@github.com/o/r.git', 'git@gitlab.com:o/r.git', 'git@github.com:o/..', 'https://github.com/o/r%2Fx', '/tmp/origin.git', 'file:///tmp/origin.git', '../origin.git']) {
    expect(parseGitHubRemote(url), url).toBeNull();
  }
});

test('every request sends the GitHub headers, and the fixture never records the token', async () => {
  await client.createPull(repository, { title: 'Add greeting', head: branch, base: 'main', body: 'Body' });
  await client.findOpenPull(repository, branch); const pull = await client.getPull(repository, 1); await client.checks(repository, pull.headSha);
  await client.merge(repository, 1, pull.headSha);
  expect(github.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['POST /repos/fixture/repo/pulls', 'GET /repos/fixture/repo/pulls', 'GET /repos/fixture/repo/pulls/1',
    `GET /repos/fixture/repo/commits/${pull.headSha}/check-runs`, `GET /repos/fixture/repo/commits/${pull.headSha}/status`, 'PUT /repos/fixture/repo/pulls/1/merge']);
  for (const request of github.requests) {
    expect(request.headers).toMatchObject({ accept: 'application/vnd.github+json', apiVersion: '2022-11-28', userAgent: 'jevellan', authorized: true });
    expect(request.headers.contentType).toBe(request.body === null ? null : 'application/json');
  }
  expect(JSON.stringify(github.requests)).not.toContain(token);
  const seen: RequestInit[] = [];
  await new GitHubClient({ token: async () => token, fetch: async (_url, init) => { seen.push(init!); return json({ total_count: 0, check_runs: [], statuses: [] }); } }).checks(repository, pull.headSha);
  expect(seen).toHaveLength(2);
  for (const init of seen) expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Authorization: `Bearer ${token}` } });
});

test('find and create pull requests read list and single shapes, and a second open pull request is refused', async () => {
  const head = git(work, 'rev-parse', 'HEAD');
  expect(await client.findOpenPull(repository, branch)).toBeNull();
  expect(github.requests[0]!.query).toEqual({ head: `fixture:${branch}`, state: 'open' });
  const created = await client.createPull(repository, { title: 'Add greeting', head: branch, base: 'main', body: 'Summary\n\nTests: Not run: no test command' });
  expect(created).toEqual({ number: 1, url: 'https://github.com/fixture/repo/pull/1', state: 'open', merged: false, mergeableState: 'clean', headSha: head, headRef: branch, baseRef: 'main' });
  expect(github.requests.at(-1)!.body).toEqual({ title: 'Add greeting', head: branch, base: 'main', body: 'Summary\n\nTests: Not run: no test command' });
  // List items carry no merge fields on GitHub.
  expect(await client.findOpenPull(repository, branch)).toEqual({ ...created, mergeableState: null });
  expect(await client.findOpenPull(repository, 'jv/other-123456')).toBeNull();
  const duplicate = await failure(client.createPull(repository, { title: 'Again', head: branch, base: 'main', body: '' }));
  expect(duplicate).toMatchObject({ kind: 'unprocessable', status: 422, message: 'Validation Failed' });
  // A force push moves the head that GitHub reports.
  writeFileSync(join(work, 'value.txt'), '3\n'); git(work, 'commit', '-a', '--amend', '-m', 'Changed again'); git(work, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  expect((await client.getPull(repository, 1)).headSha).toBe(git(work, 'rev-parse', 'HEAD'));
  expect(await failure(client.getPull(repository, 7))).toMatchObject({ kind: 'not-found', status: 404, message: 'Not Found' });
});

test('checks follow brief 8.5 from check runs and statuses only, never the combined state', async () => {
  const pull = await client.createPull(repository, { title: 'Checks', head: branch, base: 'main', body: '' });
  const cases: [GitHubFixtureChecks, string][] = [
    ['none', 'none'], ['pending', 'pending'], ['passing', 'passing'], ['passing-status', 'passing'], ['failing', 'failing'],
    ...['failure', 'cancelled', 'timed_out', 'action_required'].map((conclusion): [GitHubFixtureChecks, string] => [{ runs: [{ status: 'completed', conclusion }] }, 'failing']),
    ...['success', 'neutral', 'skipped', 'stale'].map((conclusion): [GitHubFixtureChecks, string] => [{ runs: [{ status: 'completed', conclusion }] }, 'passing']),
    ...['queued', 'in_progress', 'waiting', 'requested', 'pending'].map((status): [GitHubFixtureChecks, string] => [{ runs: [{ status, conclusion: null }] }, 'pending']),
    [{ statuses: [{ state: 'failure' }] }, 'failing'], [{ statuses: [{ state: 'error' }] }, 'failing'], [{ statuses: [{ state: 'pending' }] }, 'pending'], [{ statuses: [{ state: 'success' }] }, 'passing'],
    [{ runs: [{ status: 'queued', conclusion: null }, { status: 'completed', conclusion: 'failure' }] }, 'failing'],
    [{ runs: [{ status: 'completed', conclusion: 'success' }], statuses: [{ state: 'error' }] }, 'failing'],
    [{ runs: [{ status: 'completed', conclusion: 'success' }], statuses: [{ state: 'pending' }] }, 'pending'],
  ];
  for (const [checks, expected] of cases) {
    github.setChecks(1, checks);
    expect(await client.checks(repository, pull.headSha), JSON.stringify(checks)).toBe(expected);
  }
  // The fixture answers GitHub's empty combined status ({ state: 'pending', total_count: 0 }) for these.
  github.setChecks(1, 'passing');
  const status = await fetch(`${github.url}/repos/fixture/repo/commits/${pull.headSha}/status`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json());
  expect(status).toMatchObject({ state: 'pending', total_count: 0, statuses: [] });
  expect(await client.checks(repository, pull.headSha)).toBe('passing');
  expect(await client.checks(repository, 'a'.repeat(40))).toBe('none');
  expect(github.requests.filter((request) => request.headers.userAgent === 'jevellan' && /\/(check-runs|status)$/.test(request.path)).every((request) => request.query.per_page === '100' && request.query.page === '1')).toBe(true);
  await expect(client.checks(repository, 'HEAD')).rejects.toThrow('Invalid commit id.');
  expect(mapChecks([], [])).toBe('none');
});

test('check runs are read page by page up to their total', async () => {
  const pages: string[] = [];
  const paged = new GitHubClient({ token: async () => token, fetch: async (url) => {
    const target = new URL(String(url)); pages.push(`${target.pathname.split('/').at(-1)} ${target.searchParams.get('page')}`);
    if (target.pathname.endsWith('/status')) return json({ state: 'pending', total_count: 0, statuses: [] });
    return json(target.searchParams.get('page') === '1'
      ? { total_count: 101, check_runs: Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' })) }
      : { total_count: 101, check_runs: [{ status: 'completed', conclusion: 'timed_out' }] });
  } });
  expect(await paged.checks(repository, 'b'.repeat(40))).toBe('failing');
  expect(pages.sort()).toEqual(['check-runs 1', 'check-runs 2', 'status 1']);
});

test('mergeable states map to clean, conflict and unknown', async () => {
  for (const state of ['clean', 'unstable', 'has_hooks']) expect(mapMergeable(state), state).toBe('clean');
  expect(mapMergeable('dirty')).toBe('conflict');
  for (const state of ['unknown', 'blocked', 'behind', 'draft', null, undefined]) expect(mapMergeable(state), String(state)).toBe('unknown');
  await client.createPull(repository, { title: 'Merge state', head: branch, base: 'main', body: '' });
  for (const [state, expected] of [['dirty', 'conflict'], ['unstable', 'clean'], ['unknown', 'unknown'], ['clean', 'clean']] as const) {
    github.setMergeable(1, state);
    const pull = await client.getPull(repository, 1);
    expect(pull.mergeableState).toBe(state); expect(mapMergeable(pull.mergeableState)).toBe(expected);
  }
});

test('squash merge sends the head sha, and GitHub refusals keep their status and message', async () => {
  const pull = await client.createPull(repository, { title: 'Merge', head: branch, base: 'main', body: '' });
  github.setMergeable(1, 'dirty');
  expect(await failure(client.merge(repository, 1, pull.headSha))).toMatchObject({ kind: 'not-mergeable', status: 405, message: 'Pull Request is not mergeable' });
  github.setMergeable(1, 'clean');
  expect(await failure(client.merge(repository, 1, 'c'.repeat(40)))).toMatchObject({ kind: 'conflict', status: 409, message: 'Head branch was modified. Review and try the merge again.' });
  const merged = await client.merge(repository, 1, pull.headSha);
  expect(merged).toEqual({ merged: true, sha: expect.stringMatching(/^[a-f0-9]{40}$/), message: 'Pull Request successfully merged' });
  expect(github.requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([
    { merge_method: 'squash', sha: pull.headSha }, { merge_method: 'squash', sha: 'c'.repeat(40) }, { merge_method: 'squash', sha: pull.headSha }]);
  expect(await client.getPull(repository, 1)).toMatchObject({ state: 'closed', merged: true });
  expect(await client.findOpenPull(repository, branch)).toBeNull();
  github.closePull(1);
  await client.createPull(repository, { title: 'Closed later', head: branch, base: 'main', body: '' });
  github.setChecks(1, 'failing'); github.setChecks(2, 'pending');
  expect(await client.checks(repository, pull.headSha)).toBe('pending');
  github.closePull(2);
  expect(await client.getPull(repository, 2)).toMatchObject({ state: 'closed', merged: false });
});

test('redirects are never followed', async () => {
  await client.createPull(repository, { title: 'Redirect', head: branch, base: 'main', body: '' }); github.requests.length = 0;
  const redirected = new GitHubClient({ token: async () => token, baseUrl: `${github.url}/_redirect` });
  expect(await failure(redirected.getPull(repository, 1))).toMatchObject({ kind: 'redirect', status: 302 });
  expect(github.requests.map((request) => request.path)).toEqual(['/_redirect/repos/fixture/repo/pulls/1']);
});

test('a request that does not finish within 15 seconds times out, headers or body', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let signal: AbortSignal | undefined;
  const hanging = new GitHubClient({ token: async () => token, fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
    signal = init!.signal!; signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  }) });
  let settled = false; const pending = hanging.getPull(repository, 1).finally(() => { settled = true; }); const result = failure(pending);
  await vi.advanceTimersByTimeAsync(14_999); expect(settled).toBe(false); expect(signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ kind: 'timeout', message: 'GitHub did not answer in time.' }); expect(signal!.aborted).toBe(true);
  const stalled = new GitHubClient({ token: async () => token, fetch: async (_url, init) => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"number":')); init!.signal!.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')));
    } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const body = failure(stalled.getPull(repository, 1));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await body).toMatchObject({ kind: 'timeout' });
});

test('GitHub errors are sanitized, bounded and never carry the token', async () => {
  const shaped = ['ghp', '_', 'A'.repeat(36)].join('');
  github.failNext('GET', /\/pulls\/1$/, 403, `Token ${token} and ${shaped} are\nnot allowed\tthere.`);
  const forbidden = await failure(client.getPull(repository, 1));
  expect(forbidden).toMatchObject({ kind: 'auth', status: 403, message: 'Token [redacted] and [redacted] are not allowed there.' });
  expect(`${forbidden.message}\n${forbidden.stack}`).not.toContain(token);
  github.failNext('GET', /\/pulls\/1$/, 500, 'x'.repeat(1000));
  expect((await failure(client.getPull(repository, 1))).message).toBe('x'.repeat(300));
  // Only the first 4 KiB of an error body are read: a longer body has no readable message.
  github.failNext('GET', /\/pulls\/1$/, 500, { message: 'Hidden after the limit', padding: 'y'.repeat(5000) });
  expect(await failure(client.getPull(repository, 1))).toMatchObject({ kind: 'http', status: 500, message: 'GitHub answered with HTTP 500.' });
  github.failNext('GET', /\/pulls\/1$/, 502, { errors: [] });
  expect(await failure(client.getPull(repository, 1))).toMatchObject({ kind: 'http', status: 502, message: 'GitHub answered with HTTP 502.' });
  expect(await failure(new GitHubClient({ token: async () => 'fixture-wrong', baseUrl: github.url }).getPull(repository, 1))).toMatchObject({ kind: 'auth', status: 401, message: 'Bad credentials' });
  const network = await failure(new GitHubClient({ token: async () => token, fetch: async () => { throw new Error(`connect failed with Bearer ${token}`); } }).getPull(repository, 1));
  expect(network).toMatchObject({ kind: 'network', message: 'GitHub could not be reached.' }); expect(network.stack).not.toContain(token);
  for (const response of [() => new Response('not json', { status: 200 }), () => json({ number: 'one' }), () => json({ total_count: 1 })]) {
    expect(await failure(new GitHubClient({ token: async () => token, fetch: async () => response() }).getPull(repository, 1))).toMatchObject({ kind: 'invalid-response', message: 'GitHub returned an unexpected response.' });
  }
});

test('a missing or malformed token stops before any request, and the token joins the redactor', async () => {
  const calls: string[] = [];
  const counting: typeof fetch = async (url) => { calls.push(String(url)); return json([]); };
  for (const missing of [undefined, '', '   ']) {
    expect(await failure(new GitHubClient({ token: async () => missing, fetch: counting }).findOpenPull(repository, branch))).toMatchObject({ kind: 'no-token', message: 'No GitHub token is saved.' });
  }
  const malformed = await failure(new GitHubClient({ token: async () => `${token}\nInjected: yes`, fetch: counting }).findOpenPull(repository, branch));
  expect(malformed).toMatchObject({ kind: 'auth', message: 'The saved GitHub token is not valid.' }); expect(malformed.message).not.toContain(token);
  expect(calls).toEqual([]);
  const redactor = new SecretRedactor();
  await new GitHubClient({ token: async () => token, fetch: counting, redactor }).findOpenPull(repository, branch);
  expect(calls).toEqual([`https://api.github.com/repos/fixture/repo/pulls?head=fixture%3A${encodeURIComponent(branch)}&state=open`]);
  expect(redactor.text(`saved ${token}`)).toBe('saved [redacted]');
  await expect(client.getPull({ owner: 'fixture', repo: '..' }, 1)).rejects.toThrow('Invalid GitHub repository.');
  await expect(client.getPull(repository, 0)).rejects.toThrow('Invalid pull request number.');
});
