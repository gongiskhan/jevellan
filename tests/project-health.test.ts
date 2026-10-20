import { afterEach, expect, test, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthStepSchema, ProjectHealthCheckSchema, ProjectHealthRunSchema, ProjectHealthViewSchema, ProjectWorkSettingsSchemaV4, StoredProjectWorkSettingsSchema, defaultProjectWorkSettings, Homes } from '../packages/core/dist/index.js';
import { runHealthCheck } from '../packages/projects/dist/index.js';
import { healthCommand } from '../packages/cli/dist/health-command.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
const servers: Server[] = [], folders: string[] = []; let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const step = (url = 'http://127.0.0.1:1/') => HealthStepSchema.parse({ name: 'App answers', method: 'GET', url, expectStatus: [200] });
const definition = (url?: string) => ProjectHealthCheckSchema.parse({ id: 'check', name: 'Sandbox app', steps: [step(url)] });
async function serve(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test.each(['Authorization', 'cookie', 'Proxy-Authorization', 'X-Api-Key', 'ACCESS-TOKEN'])('refuses sign-in header %s', header => {
  const parsed = HealthStepSchema.safeParse({ ...step(), headers: { [header]: 'fixture' } });
  expect(parsed.success).toBe(false); if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe(`Health checks never sign in. Remove the ${header} header.`);
});
test.each(['http://example.invalid', 'http://localhost.example.invalid', 'ftp://localhost'])('refuses insecure URL %s', url => {
  const parsed = HealthStepSchema.safeParse({ ...step(), url }); expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('Health checks use https (http only for localhost).');
});
test('bounds definitions, refuses URL credentials, and accepts only supported steps', () => {
  expect(HealthStepSchema.safeParse({ ...step(), url: 'https://name:password@example.invalid' }).success).toBe(false);
  expect(HealthStepSchema.safeParse({ ...step(), timeoutMs: 999 }).success).toBe(false);
  expect(HealthStepSchema.safeParse({ ...step(), method: 'DELETE' }).success).toBe(false);
  expect(HealthStepSchema.safeParse({ ...step(), expectStatus: [] }).success).toBe(false);
  expect(ProjectHealthCheckSchema.safeParse({ ...definition(), steps: Array(6).fill(step()) }).success).toBe(false);
});
test('runs ordered steps, matches status and text, sends POST body, stops on failure, never retains bodies', async () => {
  const requests: string[] = [];
  const url = await serve(async (request, response) => { requests.push(request.url!); if (request.url === '/login') { let body = ''; for await (const chunk of request) body += chunk; expect(body).toBe('invalid'); response.writeHead(401); response.end('rejected'); } else if (request.url === '/failure') { response.writeHead(500); response.end('private response'); } else response.end('fixture page'); });
  const check = { ...definition(url), steps: [ { ...step(url), expectBody: 'fixture page' }, { ...step(url + '/login'), method: 'POST' as const, body: 'invalid', expectStatus: [401], expectBody: 'rejected' }, step(url + '/failure'), step(url + '/never') ] };
  const run = await runHealthCheck('project', check); expect(ProjectHealthRunSchema.parse(run)).toMatchObject({ passed: false, steps: [{ passed: true }, { passed: true, status: 401 }, { passed: false, reason: 'status 500, expected [200]' }] });
  expect(requests).toEqual(['/', '/login', '/failure']); expect(JSON.stringify(run)).not.toContain('private response');
});
test('reads only the first 64 KiB and does not follow redirects', async () => {
  let followed = false;
  const url = await serve((request, response) => { if (request.url === '/redirect') { response.writeHead(302, { Location: '/target' }); response.end(); } else if (request.url === '/target') { followed = true; response.end(); } else response.end('a'.repeat(65536) + 'late-marker'); });
  expect((await runHealthCheck('project', { ...definition(url), steps: [{ ...step(url), expectBody: 'late-marker' }] })).steps[0]?.reason).toBe('the response did not contain the expected text');
  expect((await runHealthCheck('project', definition(url + '/redirect'))).steps[0]?.reason).toBe('status 302, expected [200]'); expect(followed).toBe(false);
});
test('reports a connection failure and an actual bounded timeout', async () => {
  const bad = await runHealthCheck('project', definition()); expect(bad.steps[0]?.reason).toMatch(/^could not connect: /u);
  const url = await serve(() => undefined);
  expect((await runHealthCheck('project', { ...definition(url), steps: [{ ...step(url), timeoutMs: 1000 }] })).steps[0]?.reason).toBe('timed out after 1000 ms');
});
test('migrates settings v4 to v5 preserving choices and adding no checks', () => {
  const { healthChecks: _health, delivery: _delivery, autoLand: _land, landingChecks: _checks, smokeCheck: _smoke, mergeCommitPaths: _paths,
    coordinatorHandoffAtPercent: _handoff, deploy: _deploy, pullRequestAutoMerge: _pr, notifications, ...current } = defaultProjectWorkSettings('project'); void [_health, _delivery, _land, _checks, _smoke, _paths, _handoff, _deploy, _pr];
  const old = ProjectWorkSettingsSchemaV4.parse({ ...current, notifications: notifications.level, schema: 'project-work-settings-v4', defaultIsolation: 'worktree', autoMerge: true, instructions: 'Owner choices' });
  expect(StoredProjectWorkSettingsSchema.parse(old)).toMatchObject({ schema: 'project-work-settings-v5', instructions: 'Owner choices', autoLand: true, healthChecks: [] });
});
test('state point stores only 500 runs per check and manual API results parse', async () => {
  fixture = await projectFixture(); const f = fixture; const url = await serve((_, response) => response.end('fixture'));
  for (let n = 0; n < 501; n++) f.app.hub.put('project-health', `old_${n}`, ProjectHealthRunSchema, { schema: 'project-health-run-v1', id: `old_${n}`, projectId: f.project.id, checkId: 'check', at: new Date(n * 1000).toISOString(), trigger: 'manual', passed: true, steps: [{ name: 'App answers', passed: true, status: 200, ms: 1 }] }, 0);
  const result = await f.app.projectHealthRequest({ schema: 'project-health-request-v1', project: f.project.id, operation: 'run', definition: definition(url) });
  expect(ProjectHealthViewSchema.parse(result).runs[0]?.passed).toBe(true);
  expect(f.app.hub.list('project-health', ProjectHealthRunSchema)).toHaveLength(500);
});
test('CLI validates --file, prints results and returns failing exit code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'health-cli-')); folders.push(root); const file = join(root, 'check.json'); writeFileSync(file, JSON.stringify(definition()));
  const run = await runHealthCheck('project', definition()); const request = vi.fn<NonNullable<Parameters<typeof healthCommand>[2]>>().mockResolvedValue(ProjectHealthViewSchema.parse({ schema: 'project-health-view-v1', projectId: 'project', runs: [run] }));
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await healthCommand(['run', 'project', '--file', file, '--json'], new Homes(root), request)).toBe(1);
  expect(request.mock.calls[0]?.[2]).toMatchObject({ definition: definition() }); expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toHaveProperty('runs');
  request.mockResolvedValue(ProjectHealthViewSchema.parse({ schema: 'project-health-view-v1', projectId: 'project', runs: [{ ...run, passed: true, steps: [{ name: 'App answers', passed: true, ms: 1, status: 200 }] }] }));
  expect(await healthCommand(['run', 'project'], new Homes(root), request)).toBe(0);
  await expect(healthCommand(['run', 'project', '--file'], new Homes(root), request)).rejects.toThrow('--file needs a path.');
});

test('a member routes health to the state point and the installed CLI reads its control file', async () => {
  fixture = await projectFixture({ control: true }); const f = fixture, member = await projectMember(f);
  const url = await serve((_, response) => response.end('fixture'));
  const result = await member.json(`/api/projects/${f.project.id}/health/run`, ProjectHealthViewSchema, 'POST', { schema: 'project-health-request-v1', project: f.project.id, operation: 'run', definition: definition(url) });
  expect(result.runs[0]?.passed).toBe(true); expect(f.app.hub.list('project-health', ProjectHealthRunSchema)).toHaveLength(1);
  expect(() => member.app.hub).toThrow('A member has no authoritative hub database.');
  const file = join(f.root, 'health-definition.json'); writeFileSync(file, JSON.stringify(definition(url)));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await healthCommand(['run', f.project.id, '--file', file], f.homes)).toBe(0);
  expect(f.app.hub.list('project-health', ProjectHealthRunSchema)).toHaveLength(2);
  const list = await member.json(`/api/projects/${f.project.id}/health`, ProjectHealthViewSchema);
  expect(list.runs).toHaveLength(2);
});

test('health API returns the exact header and URL refusals', async () => {
  fixture = await projectFixture(); const f = fixture;
  for (const [patch, message] of [
    [{ headers: { Authorization: 'fixture' } }, 'Health checks never sign in. Remove the Authorization header.'],
    [{ url: 'http://example.invalid' }, 'Health checks use https (http only for localhost).'],
  ] as const) {
    const response = await f.request(`/api/projects/${f.project.id}/health/run`, 'POST', { schema: 'project-health-request-v1', project: f.project.id, operation: 'run', definition: { ...definition(), steps: [{ ...step(), ...patch }] } });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ message });
  }
});
