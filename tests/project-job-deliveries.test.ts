import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectJobRunSchema, ProjectJobSchema, SecretRedactor } from '../packages/core/dist/index.js';
import { ThreadGit } from '../packages/projects/dist/index.js';
import { importJobDeliveries, deliveryDirectory, PrivateJobDeliverySchema } from '../packages/projects/dist/job-deliveries.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function setup() {
  f = await projectFixture(); const fixture = f, commit = f.git(f.checkout, 'rev-parse', 'HEAD'), at = new Date().toISOString();
  const job = ProjectJobSchema.parse({ schema: 'project-job-v1', id: 'job_delivery', projectId: 'project', revision: 1, name: 'Delivery fixture', enabled: true, goalId: null, gate: null, run: { kind: 'command', command: 'true', cwd: 'workspace', timeoutMinutes: 1, deliveryGate: { id: 'fixture_gate', command: 'false', timeoutMinutes: 1, protectedPaths: ['evals/'] } }, createdAt: at, updatedAt: at });
  fixture.app.hub.put('project-jobs', job.id, ProjectJobSchema, job, 0);
  const run = ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id: 'run_delivery', projectId: 'project', revision: 1, jobId: job.id, taskId: 'parent', commit, deviceId: fixture.app.device.deviceId, projectDay: at.slice(0, 10), startedAt: at, conclusion: null, summary: '', logTail: '', phase: 'executing', spec: job.run, baseBranch: 'main', watchAfter: at });
  fixture.app.hub.put('project-job-runs', run.id, ProjectJobRunSchema, run, 0);
  const workspace = fixture.homes.ensure('project-work', 'project', 'job-workspaces', run.id);
  const publicText = 'Dev-only fixture', privateText = JSON.stringify({ schema: 'fixture-gate-input-v1', private: 'private fixture split' });
  mkdirSync(join(workspace, 'results')); writeFileSync(join(workspace, 'results', 'dev.txt'), publicText); writeFileSync(join(workspace, 'results', 'gate.json'), privateText);
  const delivery = { id: 'candidate', title: 'Improve fixture', brief: 'Use the attached dev data.', type: 'feature', files: [{ ref: 'results/dev.txt', name: 'dev.txt', sha256: sha(publicText) }], gateInput: { ref: 'results/gate.json', sha256: sha(privateText) } };
  const manifest = { schema: 'project-job-deliveries-v1', deliveries: [delivery] };
  writeFileSync(join(workspace, 'project-job-deliveries.json'), JSON.stringify(manifest));
  const o = { homes: fixture.homes, run, workspace, repo: fixture.checkout, git: new ThreadGit({ homes: fixture.homes, redactor: new SecretRedactor() }), gitEnv: {}, library: fixture.app.library, redactor: new SecretRedactor() };
  return { fixture, o, manifest };
}

test('job deliveries publish a base branch and dev Library file once, keeping gate data private', async () => {
  const { fixture, o } = await setup(); const [first] = await importJobDeliveries(o), [retry] = await importJobDeliveries(o);
  expect(retry).toEqual(first); expect(first!.gate?.command).toBe('false'); expect(first!.brief).toContain('Attached file: library/jobs/run_delivery/');
  expect(fixture.git(fixture.origin, 'rev-parse', `refs/heads/${first!.fromBranch}`)).toBe(o.run.commit);
  const items = await fixture.app.library.list('project'); expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ source: 'job', jobRunId: o.run.id, artifactId: 'candidate_0' });
  expect(readFileSync((await fixture.app.library.get('project', items[0]!.id)).localPath, 'utf8')).toBe('Dev-only fixture');
  const privateFile = JSON.parse(readFileSync(join(deliveryDirectory(fixture.homes, 'project', o.run.id), 'candidate.json'), 'utf8')) as unknown;
  expect(PrivateJobDeliverySchema.parse(privateFile).input).toEqual({ schema: 'fixture-gate-input-v1', private: 'private fixture split' });
  expect(JSON.stringify(first)).not.toContain('private fixture split'); expect(JSON.stringify(items)).not.toContain('gate.json');
});

test('a missing gate input, changed artifact or path escape fails before publishing a delivery', async () => {
  const { fixture, o, manifest } = await setup();
  delete (manifest.deliveries[0] as { gateInput?: unknown }).gateInput;
  writeFileSync(join(o.workspace, 'project-job-deliveries.json'), JSON.stringify(manifest));
  await expect(importJobDeliveries(o)).rejects.toThrow('requires a private gate input');
  expect(fixture.git(fixture.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/jevellan/jobs')).toBe('');
  const escaped = { ...manifest.deliveries[0]!, gateInput: { ref: '../secret.json', sha256: 'a'.repeat(64) } };
  writeFileSync(join(o.workspace, 'project-job-deliveries.json'), JSON.stringify({ ...manifest, deliveries: [escaped] }));
  await expect(importJobDeliveries(o)).rejects.toThrow('relative file');
});

test('job artifact retries refuse different bytes under the same identity', async () => {
  const { fixture, o } = await setup(); await importJobDeliveries(o);
  writeFileSync(join(o.workspace, 'results', 'dev.txt'), 'Changed fixture');
  await expect(fixture.app.library.addJob('project', o.run.id, 'candidate_0', o.workspace, { path: 'results/dev.txt', name: 'dev.txt' })).rejects.toThrow('different content');
  expect(await fixture.app.library.list('project')).toHaveLength(1);
});

test('restart imports a completed data outbox without repeating the native job or duplicating tasks', async () => {
  const { ProjectWorkTaskSchema, defaultProjectWorkSettings } = await import('../packages/core/dist/index.js');
  const { fixture, o } = await setup(); const work = fixture.app.projectWork; await work.coordinators.ensureAssigned('project');
  await fixture.app.projectHub.putSettings({ ...defaultProjectWorkSettings('project'), status: 'paused' }, 0);
  const at = o.run.startedAt;
  fixture.app.hub.put('project-work-tasks', o.run.taskId, ProjectWorkTaskSchema, ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id: o.run.taskId, projectId: 'project', revision: 1, title: 'Interrupted job', brief: 'Recover its data only.', kind: 'job', type: 'ops', goalId: null, source: 'owner', state: 'active', rank: '4', ownerRanked: false, now: false, after: [], needs: [], dailyId: null, jobId: o.run.jobId, threadId: null, jobRunId: o.run.id, fixed: {}, createdAt: at, updatedAt: at }), 0);
  await work.jobs.sweep('project'); await fixture.waitFor(async () => (await fixture.app.projectHub.jobRun(o.run.id))?.document.conclusion, value => value === 'failed'); await fixture.waitFor(() => work.jobs.busy(), value => !value);
  await work.jobs.sweep('project'); await fixture.waitFor(() => work.jobs.busy(), value => !value);
  const run = (await fixture.app.projectHub.jobRun(o.run.id))!.document;
  expect(run.summary).toContain('not repeated'); expect(run.deliveries).toHaveLength(1);
  const tasks = (await work.tasks.list('project')).filter(task => task.jobDelivery); expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ fromBranch: run.deliveries[0]!.fromBranch, jobDelivery: { runId: run.id, deliveryId: 'candidate' }, fixed: { deviceId: run.deviceId } });
  expect(await fixture.app.library.list('project')).toHaveLength(1); expect(fixture.fake.starts).toHaveLength(0);
});


test('bounded scheduler landing receipts retain the source delivery identity', async () => {
  const { LegalLandingReceiptsSchema } = await import('../packages/projects/dist/job-deliveries.js');
  const merge = { taskId: 'task_one', pr: 'task_one', runId: 'run_one', deliveryId: 'candidate', title: 'Measured change', mergedAt: '2026-10-19T12:00:00.000Z', mergeSha: 'a'.repeat(40), gate: 'fixture_gate', mergeStrategy: 'merge', gatePassed: true, date: '2026-10-19' };
  expect(LegalLandingReceiptsSchema.parse({ schema: 'jevellan-legal-landings-v1', merges: [merge], reverts: [] }).merges[0]).toEqual(merge);
  expect(LegalLandingReceiptsSchema.safeParse({ schema: 'jevellan-legal-landings-v1', merges: Array.from({ length: 1001 }, () => merge), reverts: [] }).success).toBe(false);
});
