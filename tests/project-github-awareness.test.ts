import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GithubInputSchema, ProjectSchema, SecretRedactor, ThreadIndexSchema, type ThreadIndex } from '../packages/core/dist/index.js';
import { GitHubAccess, ProjectGithub } from '../packages/projects/dist/index.js';
import { startGitHubFixture, type GitHubFixture } from './fixtures/github-server.mjs';

let root: string, github: GitHubFixture, access: GitHubAccess, reader: ProjectGithub, current: ThreadIndex, time: number, token: string, credential: string;
const signal = new AbortController().signal, repository = { owner: 'fixture', repo: 'repo' }, coordinator = { kind: 'coordinator' as const, projectId: 'proj_github', turn: 1 };
const thread = { kind: 'thread' as const, projectId: 'proj_github', threadId: 'thread_github', turn: 1, isolation: 'worktree' as const };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-github-awareness-'))); const origin = join(root, 'origin.git'), work = join(root, 'work');
  git(root, 'init', '--bare', '-b', 'main', origin); git(root, 'clone', origin, work); writeFileSync(join(work, 'value.txt'), 'before\n');
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'Baseline'); git(work, 'push', '-u', 'origin', 'main'); git(work, 'switch', '-c', 'feature');
  writeFileSync(join(work, 'value.txt'), 'after\n'); git(work, 'commit', '-am', 'Change value'); git(work, 'push', 'origin', 'feature');
  token = credential = `fixture-${randomUUID()}`; time = Date.now(); github = await startGitHubFixture({ token, repositories: { 'fixture/repo': origin } });
  const redactor = new SecretRedactor(); access = new GitHubAccess({ credential: async () => credential, baseUrl: github.url, redactor });
  const pull = await (await access.open()).createPull(repository, { title: 'Improve value', head: 'feature', base: 'main', body: '' });
  current = ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 1, id: 'thread_github', projectId: coordinator.projectId, title: 'Improve value', state: 'in-review',
    isolation: 'worktree', ownerDeviceId: 'dev_fixture', runtime: 'codex', modelLabel: 'Fixture', accountLabel: 'Fixture', effort: 'medium', turns: 1,
    createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), pr: { number: pull.number, url: pull.url, headSha: pull.headSha, state: 'open', checks: 'none', mergeable: 'clean', updatedAt: new Date(time).toISOString() } });
  const project = ProjectSchema.parse({ schema: 'project-v1', id: coordinator.projectId, name: 'GitHub fixture', remoteUrl: 'https://github.com/fixture/repo.git', paths: {},
    branchPolicy: 'main', memory: { mode: 'device', dir: 'memory' }, context: { state: 'none' } });
  reader = new ProjectGithub({ github: access, redactor, now: () => time, project: async () => project, thread: async () => current, baseBranch: async () => 'main' });
  github.requests.length = 0;
});
afterEach(async () => { await github?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

test('the six versioned actions expose real fixture runs, jobs, checks, changed files, any author and commit associations', async () => {
  const at = new Date(time).toISOString(); github.pulls[0]!.author = 'another-author'; github.setChecks(1, { runs: [{ name: 'result', status: 'completed', conclusion: 'failure' }] });
  const run = github.addWorkflow({ workflow: 'checks.yml', head_sha: current.pr!.headSha, head_branch: 'feature', event: 'pull_request', created_at: at, run_started_at: at,
    updated_at: new Date(time + 12_000).toISOString(), jobs: [{ id: 77, name: 'result', status: 'completed', conclusion: 'failure', steps: [{ name: 'Changelog', status: 'completed', conclusion: 'failure' }], logs: 'CHANGELOG.md has no entry for this change' }] });
  expect(await reader.read(coordinator, { action: 'runs', workflow: 'checks.yml', branch: 'feature', event: 'pull_request', status: 'completed' }, signal))
    .toMatchObject({ schema: 'github-runs-v1', runs: [{ id: run.id, workflow: 'checks.yml', headSha: current.pr!.headSha, durationSeconds: 12 }] });
  expect(await reader.read(coordinator, { action: 'run', runId: run.id }, signal)).toMatchObject({ schema: 'github-run-v1', jobs: [{ id: 77, steps: [{ name: 'Changelog', conclusion: 'failure' }] }] });
  expect(await reader.read(coordinator, { action: 'job_log', jobId: 77 }, signal)).toEqual({ schema: 'github-job-log-v1', jobId: 77, output: 'CHANGELOG.md has no entry for this change' });
  expect(await reader.read(coordinator, { action: 'pulls', state: 'open' }, signal)).toMatchObject({ schema: 'github-pulls-v1', pulls: [{ number: 1, author: 'another-author', draft: false, checks: 'failing', mergeable: 'unknown' }] });
  expect(await reader.read(coordinator, { action: 'pull', number: 1 }, signal)).toMatchObject({ schema: 'github-pull-v1', pull: { number: 1, checks: 'failing', mergeable: 'clean' }, checks: [{ name: 'result', conclusion: 'failure' }], files: [{ path: 'value.txt', additions: 1, deletions: 1 }] });
  github.markMerged(1);
  expect(await reader.read(coordinator, { action: 'commits', branch: 'feature' }, signal)).toMatchObject({ schema: 'github-commits-v1', branch: 'feature', commits: [{ subject: 'Change value', mergedPull: 1 }, { subject: 'Baseline', mergedPull: null }] });
  expect((await reader.read(coordinator, { action: 'commits' }, signal)).schema).toBe('github-commits-v1');
  expect(github.requests.every(request => request.method === 'GET')).toBe(true);
});

test('concurrent identical reads share a request, expire at 60 seconds, retry errors and invalidate on token rotation', async () => {
  await Promise.all(Array.from({ length: 5 }, () => reader.read(coordinator, { action: 'runs' }, signal)));
  expect(github.requests).toHaveLength(1); time += 59_999; await reader.read(coordinator, { action: 'runs' }, signal); expect(github.requests).toHaveLength(1);
  time += 1; await reader.read(coordinator, { action: 'runs' }, signal); expect(github.requests).toHaveLength(2);
  credential = `rotated-${randomUUID()}`; await expect(reader.read(coordinator, { action: 'runs' }, signal)).rejects.toThrow('Bad credentials'); expect(github.requests).toHaveLength(3);
  credential = token; time += 60_000; github.failNext('GET', /actions\/runs$/u, 503, 'Try again');
  await expect(reader.read(coordinator, { action: 'runs' }, signal)).rejects.toThrow('Try again');
  await reader.read(coordinator, { action: 'runs' }, signal); expect(github.requests).toHaveLength(5);
});

test('thread scope refuses lists and other pulls before any request, and never downloads logs on another head', async () => {
  for (const input of [{ action: 'runs' }, { action: 'pulls', state: 'open' }, { action: 'commits' }, { action: 'pull', number: 2 }])
    await expect(reader.read(thread, input, signal)).rejects.toMatchObject({ status: 403 });
  expect(github.requests).toHaveLength(0);
  const own = github.addWorkflow({ head_sha: current.pr!.headSha, jobs: [{ id: 101, name: 'result', status: 'completed', conclusion: 'failure', logs: 'own failure' }] });
  const other = github.addWorkflow({ head_sha: 'a'.repeat(40), jobs: [{ id: 102, name: 'result', status: 'completed', conclusion: 'failure', logs: 'other failure' }] });
  await expect(reader.read(thread, { action: 'run', runId: other.id }, signal)).rejects.toMatchObject({ status: 403 });
  await expect(reader.read(thread, { action: 'job_log', jobId: 102 }, signal)).rejects.toMatchObject({ status: 403 });
  expect(github.requests.some(request => request.path.endsWith('/102/logs') || request.path.endsWith(`/${other.id}/jobs`))).toBe(false);
  expect(await reader.read(thread, { action: 'pull', number: 1 }, signal)).toMatchObject({ schema: 'github-pull-v1' });
  expect(await reader.read(thread, { action: 'run', runId: own.id }, signal)).toMatchObject({ schema: 'github-run-v1' });
  expect(await reader.read(thread, { action: 'job_log', jobId: 101 }, signal)).toMatchObject({ output: 'own failure' });
  current.pr!.headSha = 'b'.repeat(40);
  await expect(reader.read(thread, { action: 'run', runId: own.id }, signal)).rejects.toMatchObject({ status: 403 });
  await expect(reader.read(thread, { action: 'job_log', jobId: 101 }, signal)).rejects.toMatchObject({ status: 403 });
  current.projectId = 'proj_other'; await expect(reader.read(thread, { action: 'pull', number: 1 }, signal)).rejects.toMatchObject({ status: 403 });
});

test('large job logs are streamed to a bounded, redacted tail and smaller tails share the download', async () => {
  github.addWorkflow({ head_sha: current.pr!.headSha, jobs: [{ id: 90, name: 'result', status: 'completed', conclusion: 'failure', logs: `${'x'.repeat(5 * 1024 * 1024)}\n${token}\nCHANGELOG.md is missing` }] });
  const full = await reader.read(coordinator, { action: 'job_log', jobId: 90, tailChars: 8000 }, signal);
  expect(full).toMatchObject({ schema: 'github-job-log-v1', output: expect.stringContaining('CHANGELOG.md is missing') });
  expect(JSON.stringify(full)).not.toContain(token); if (full.schema === 'github-job-log-v1') expect(full.output.length).toBeLessThanOrEqual(8000);
  const short = await reader.read(coordinator, { action: 'job_log', jobId: 90, tailChars: 40 }, signal);
  if (short.schema === 'github-job-log-v1') expect(short.output.length).toBeLessThanOrEqual(40);
  expect(github.requests.filter(request => request.path.endsWith('/logs'))).toHaveLength(1);
});

test('inputs enforce action-specific limits and refuse unrecognised or acting operations', () => {
  for (const input of [{ action: 'merge', number: 1 }, { action: 'runs', limit: 21 }, { action: 'pulls', state: 'all' }, { action: 'commits', limit: 31 },
    { action: 'job_log', jobId: 1, tailChars: 8001 }, { action: 'run', runId: -1 }, { action: 'pull', number: 1, merge: true }]) expect(GithubInputSchema.safeParse(input).success).toBe(false);
  expect(GithubInputSchema.parse({ action: 'job_log', jobId: 1 })).toEqual({ action: 'job_log', jobId: 1, tailChars: 4000 });
});

test('awareness reads update the existing per-token GitHub budget, visible to a separate publication client', async () => {
  let remaining = 1000;
  const monitored = new GitHubAccess({ credential: async () => token, baseUrl: github.url, redactor: new SecretRedactor(), fetch: async (url, init) => {
    const response = await fetch(url, init), headers = new Headers(response.headers);
    headers.set('x-ratelimit-remaining', String(--remaining)); headers.set('x-ratelimit-limit', '5000'); headers.set('x-ratelimit-reset', String(Math.floor((time + 3_600_000) / 1000)));
    return new Response(response.body, { status: response.status, headers });
  } });
  const project = ProjectSchema.parse({ schema: 'project-v1', id: coordinator.projectId, name: 'Fixture', remoteUrl: 'https://github.com/fixture/repo.git', paths: {},
    branchPolicy: 'main', memory: { mode: 'device', dir: 'memory' }, context: { state: 'none' } });
  const aware = new ProjectGithub({ github: monitored, redactor: new SecretRedactor(), now: () => time, project: async () => project, thread: async () => current, baseBranch: async () => 'main' });
  await aware.read(coordinator, { action: 'pull', number: 1 }, signal);
  expect(await access.client(token).rateLimit()).toMatchObject({ remaining: 996, limit: 5000 });
  await aware.read(coordinator, { action: 'pull', number: 1 }, signal); expect(remaining).toBe(996);
});
