import { afterEach, expect, test } from 'vitest';
import { ProjectDeploySchema, ProjectWorkTaskSchema, DeviceViewSchema, DeviceSchema, ProjectJobRunSchema, ProjectJobSchema, ProjectSchema, minimalEnvironment, projectEnvironment } from '../packages/core/dist/index.js';
import { placeCommandJob, workflowEnvironmentReferences } from '../packages/projects/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const at = '2026-10-19T10:00:00Z';
const facts = { schema: 'device-facts-v1', cores: 8, load1: 1, load5: 1, totalMemoryBytes: 32e9, freeMemoryBytes: 16e9, freeDiskBytes: 100e9, os: 'linux', runningThreads: [], runningJobRuns: [] };
const device = (id: string, name = id, tags = ['linux']) => DeviceViewSchema.parse({ schema: 'device-view-v1', device: { schema: 'device-v1', id, name, role: 'member', url: 'http://127.0.0.1:9771', os: 'linux', version: '0.6.0', joinedAt: at, tags }, status: 'online', revoked: false, heartbeat: { schema: 'heartbeat-v1', deviceId: id, at, version: '0.6.0', runningConversations: [], projects: [], externalSessions: [], load: { cpuPct: 0, memFreeMb: 16000 }, facts } });
const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Sandbox', paths: { a: '/a', b: '/b' }, branchPolicy: 'external', context: { state: 'none' }, memory: { mode: 'repo', dir: 'memory' } });
async function command(f: ProjectFixture, name: string, needs: string[] = [], script = 'true') {
  return f.json('/api/projects/project/jobs', ProjectJobSchema, 'POST', { schema: 'job-create-request-v1', clientRequestId: name, name, goalId: null, enabled: true, run: { kind: 'command', command: script, timeoutMinutes: 1, needs }, gate: null });
}
test('placement uses tags, guards, allowed devices and stable least-running ordering', () => {
  const a = device('a', 'Zulu'), b = device('b', 'Alpha');
  expect(placeCommandJob(project, ['linux'], [a, b], [], [])).toEqual({ deviceId: 'b' });
  b.heartbeat!.facts!.runningThreads = ['other'];
  expect(placeCommandJob(project, ['linux'], [a, b], [], [])).toEqual({ deviceId: 'a' });
  a.heartbeat!.facts!.freeDiskBytes = 1;
  expect(placeCommandJob(project, ['linux'], [a, b], [], [])).toEqual({ deviceId: 'b' });
  b.device.workPolicy = { schema: 'device-work-policy-v1', mode: 'apps-only' };
  expect(placeCommandJob(project, ['linux'], [a, b], [], []).reason).toMatch(/^Waiting for a device with linux: /u);
  expect(placeCommandJob({ ...project, allowedDevices: ['a'] }, ['mac'], [device('a'), device('b', 'B', ['mac'])], [], []).deviceId).toBeUndefined();
  const missing = device('a'); missing.heartbeat!.facts = undefined;
  expect(placeCommandJob(project, [], [missing], [], []).reason).toContain('resource facts unavailable');
});
test('workflow inventory finds dot and bracket references without returning any values', () => {
  const rows = workflowEnvironmentReferences('night.yml', "env:\n  LOGIN: ${{ secrets.FIXTURE_AUTH }}\n  MODE: ${{ vars['FIXTURE_MODE'] || 'default-value' }}\n  TOKEN: ${{ secrets[\"FIXTURE_SECOND\"] }}");
  expect(rows.map(row => [row.name, row.kind, row.line])).toEqual([['FIXTURE_AUTH', 'secret', 2], ['FIXTURE_MODE', 'variable', 3], ['FIXTURE_SECOND', 'secret', 4]]);
  expect(JSON.stringify(rows)).not.toContain('default-value');
});
test('command credentials never replace a managed runtime account or its home', () => {
  const values = { CLAUDE_CODE_OAUTH_TOKEN: 'job-only', OPENAI_API_KEY: 'job-api', FIXTURE_VARIABLE: 'plain' };
  expect(projectEnvironment(values, 'command')).toEqual(values);
  const runtime = minimalEnvironment('claude', '/isolated', { CLAUDE_CODE_OAUTH_TOKEN: 'managed' }, {}, {}, values);
  expect(runtime.CLAUDE_CODE_OAUTH_TOKEN).toBe('managed'); expect(runtime.OPENAI_API_KEY).toBeUndefined(); expect(runtime.FIXTURE_VARIABLE).toBe('plain');
  expect(() => projectEnvironment({ HOME: '/native' }, 'command')).toThrow('reserved');
});
test('a local command starts instead of waiting on its own admission', async () => {
  const f = fixture = await projectFixture(); const job = await command(f, 'local');
  const receipt = await f.app.projectWork.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'local_run' });
  await f.app.projectWork.dispatcher.sweep('project');
  const runs = await f.app.projectWork.jobs.runs('project'); expect(runs.find(run => run.taskId === receipt.taskId)?.phase).not.toBe('waiting');
});
test('a command runs through the member relay, has the executing device on the hub and redacts vault secrets', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  const row = f.app.hub.get('devices', member.deviceId, DeviceSchema)!; f.app.hub.put('devices', member.deviceId, DeviceSchema, { ...row.document, tags: ['member-test'] }, row.revision);
  const settings = await f.app.projectWork.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, environment: { variables: [], secrets: ['FIXTURE_SECRET'], copyFiles: [] } }, settings.revision);
  await f.app.state.environment.put('project', 'FIXTURE_SECRET', 'disposable relay credential');
  const job = await command(f, 'remote', ['member-test'], 'printf "%s" "$FIXTURE_SECRET"');
  const receipt = await f.app.projectWork.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'remote_run' });
  await f.app.projectWork.dispatcher.sweep('project'); await member.app.projectWork.inbox.poll();
  await f.waitFor(() => f.app.projectWork.jobs.runs('project'), runs => runs.some(run => run.taskId === receipt.taskId && run.conclusion === 'passed'));
  await f.app.projectWork.jobs.sweep('project');
  const run = (await f.app.projectWork.jobs.runs('project')).find(run => run.taskId === receipt.taskId)!;
  expect(run.deviceId).toBe(member.deviceId); expect(run.logTail).not.toContain('disposable relay credential'); expect(run.logTail).toContain('[redacted]');
  expect((await f.app.projectWork.tasks.read('project', receipt.taskId)).state).toBe('done');
  expect(ProjectJobRunSchema.parse(run).phase).toBe('finished');
});

test('a resource wait retries after tags appear and expires after six hours', async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  const job = await command(f, 'later', ['later-device']);
  await f.app.projectWork.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'later_run' });
  await f.app.projectWork.dispatcher.sweep('project');
  let run = (await f.app.projectWork.jobs.runs('project'))[0]!; expect(run.phase).toBe('waiting'); expect(run.summary).toContain('Waiting for a device with later-device:');
  const row = f.app.hub.get('devices', f.app.device.deviceId, DeviceSchema)!; f.app.hub.put('devices', row.document.id, DeviceSchema, { ...row.document, tags: ['later-device'] }, row.revision);
  await f.app.projectWork.jobs.sweep('project');
  await f.waitFor(() => f.app.projectWork.jobs.runs('project'), rows => rows.some(row => row.id === run.id && row.conclusion === 'passed'));
  await f.app.projectWork.idle();
  const unavailable = await command(f, 'expire', ['absent-tag']); await f.app.projectWork.daily.runJob('project', unavailable.id, { schema: 'project-run-request-v1', clientRequestId: 'expired_run' });
  await f.app.projectWork.dispatcher.sweep('project'); run = (await f.app.projectWork.jobs.runs('project')).find(row => row.jobId === unavailable.id)!; expect(run.phase).toBe('waiting');
  now += 6 * 3600000; await f.app.projectWork.jobs.sweep('project');
  await f.waitFor(() => f.app.projectWork.jobs.runs('project'), rows => rows.some(row => row.id === run.id && row.conclusion === 'skipped'));
});

test('a night job with no device skips at the night window end', async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), work = f.app.projectWork;
  const job = await command(f, 'night_wait', ['unavailable']); await work.idle();
  const { ProjectDailyWork } = await import('../packages/projects/dist/index.js');
  const quiet = new ProjectDailyWork({ ...work.daily.o, changed: () => undefined });
  const receipt = await quiet.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'night_wait_run' });
  let task = await work.tasks.read('project', receipt.taskId);
  const openedAt = new Date(now).toISOString();
  await f.app.projectHub.putWindow({ schema: 'project-window-v1', id: 'night_wait_window', projectId: 'project', revision: 0, date: openedAt.slice(0, 10), closingProjectDay: task.projectDay!, state: 'open', memoryDreamPending: false, mergesHeld: true, openedAt, taskIds: [], plans: [] }, 0);
  task = await work.tasks.save({ ...task, nightlyWindowId: 'night_wait_window' }); await work.jobs.start(task);
  let run = (await work.jobs.runs('project'))[0]!; expect(run.phase).toBe('waiting');
  now += 7 * 3600000; await work.jobs.sweep('project');
  run = await f.waitFor(async () => (await work.jobs.runs('project'))[0]!, row => row.conclusion === 'skipped');
  expect(run.summary).toBe('No device was available before the night window ended.');
});

test('copying a vault credential returns only a summary, including through a member', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  await f.app.state.environment.put('project', 'STAGED_FIXTURE', 'disposable staged secret');
  await f.app.state.environment.copy('project', 'DIRECT_FIXTURE', { kind: 'secret', name: 'STAGED_FIXTURE' });
  await member.app.state.environment.copy('project', 'OPENAI_API_KEY', { kind: 'secret', name: 'STAGED_FIXTURE' });
  const response = await member.request('/api/projects/project/env-secrets/OPENAI_API_KEY/import', 'POST', { schema: 'project-env-import-request-v1', source: { kind: 'secret', name: 'STAGED_FIXTURE' } });
  const result = await response.text(); expect(response.status, result).toBe(200); expect(result).not.toContain('disposable staged secret'); expect(JSON.parse(result)).toMatchObject({ name: 'OPENAI_API_KEY', saved: true });
  const settings = await f.app.projectWork.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, environment: { variables: [], secrets: ['OPENAI_API_KEY'], copyFiles: [] } }, settings.revision);
  expect((await f.app.state.environment.credentials('project')).OPENAI_API_KEY).toBe('disposable staged secret');
});

test('a project paused during a device wait starts no job when capacity returns', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await command(f, 'paused_wait', ['returns-later']);
  await work.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'paused_wait_run' }); await work.dispatcher.sweep('project');
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, status: 'paused' }, settings.revision);
  const row = f.app.hub.get('devices', f.app.device.deviceId, DeviceSchema)!; f.app.hub.put('devices', row.document.id, DeviceSchema, { ...row.document, tags: ['returns-later'] }, row.revision);
  await work.jobs.sweep('project'); expect((await work.jobs.runs('project'))[0]?.phase).toBe('waiting');
});

test('a retained workspace gets the pinned job context and leaves the registered checkout alone', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  let job = await command(f, 'workspace_context', [], 'test "$JEVELLAN_JOB_COMMIT" = "$(git rev-parse HEAD)" && test -d "$JEVELLAN_JOB_CACHE" && printf report > report.txt');
  job = (await f.app.projectHub.putJob({ ...job, run: { ...job.run, kind: 'command', command: job.run.kind === 'command' ? job.run.command : 'false', timeoutMinutes: 1, needs: [], cwd: 'workspace' } }, job.revision)).document;
  await work.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'workspace_context_run' }); await work.dispatcher.sweep('project');
  const run = await f.waitFor(async () => (await work.jobs.runs('project'))[0]!, row => row.conclusion === 'passed'); await work.idle(); await work.jobs.cleanup('project');
  const { existsSync } = await import('node:fs');
  expect(existsSync(f.homes.at('project-work', 'project', 'job-workspaces', run.id, 'checkout', 'report.txt'))).toBe(true);
  expect(existsSync(f.checkout + '/report.txt')).toBe(false); expect(run.workspaceRetainedAt).toBeDefined();
});

test('a reserved receipt blocks a second job on the same device or project', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork, member = await projectMember(f);
  const { ProjectDailyWork } = await import('../packages/projects/dist/index.js');
  const first = await command(f, 'slot_first', ['missing']), second = await command(f, 'slot_second', ['missing']); await work.idle();
  const quiet = new ProjectDailyWork({ ...work.daily.o, changed: () => undefined });
  const a = await quiet.runJob('project', first.id, { schema: 'project-run-request-v1', clientRequestId: 'slot_a' }); await work.jobs.start(await work.tasks.read('project', a.taskId));
  const b = await quiet.runJob('project', second.id, { schema: 'project-run-request-v1', clientRequestId: 'slot_b' }); await work.jobs.start(await work.tasks.read('project', b.taskId));
  const runs = await work.jobs.runs('project'), left = runs.find(run => run.jobId === first.id)!, right = runs.find(run => run.jobId === second.id)!;
  await f.app.projectHub.putJobRun({ ...left, phase: 'reserved' }, left.revision);
  await expect(f.app.projectHub.putJobRun({ ...right, deviceId: member.deviceId, phase: 'reserved' }, right.revision)).rejects.toThrow('One job runs per project and per device at a time.');
  await f.app.state.projects.put({ ...f.project, id: 'other_project', name: 'Other project', paths: {}, remoteUrl: 'https://github.com/fixture/other.git' }, 0);
  await f.app.projectHub.assignCoordinator('other_project', f.app.device.deviceId, 0);
  const otherJob = await quiet.createJob('other_project', { schema: 'job-create-request-v1', clientRequestId: 'other_job', name: 'Other job', goalId: null, enabled: true, run: { kind: 'command', command: 'true', needs: [], cwd: 'checkout', timeoutMinutes: 1 }, gate: null });
  const otherTask = await quiet.runJob('other_project', otherJob.id, { schema: 'project-run-request-v1', clientRequestId: 'other_job_run' });
  await expect(f.app.projectHub.putJobRun({ ...right, id: 'other_slot', revision: 0, projectId: 'other_project', jobId: otherJob.id, taskId: otherTask.taskId, spec: otherJob.run, phase: 'reserved' }, 0)).rejects.toThrow('One job runs per project and per device at a time.');
});

test('the coordinator can cancel a command executing on a member without repeating it', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork, member = await projectMember(f);
  const row = f.app.hub.get('devices', member.deviceId, DeviceSchema)!; f.app.hub.put('devices', member.deviceId, DeviceSchema, { ...row.document, tags: ['remote-cancel'] }, row.revision);
  const job = await command(f, 'cancel_remote', ['remote-cancel'], 'sleep 60');
  const receipt = await work.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'cancel_remote_run' });
  await work.dispatcher.sweep('project'); await member.app.projectWork.inbox.poll();
  await f.waitFor(() => work.jobs.runs('project'), runs => runs.some(run => run.taskId === receipt.taskId && run.phase === 'executing'));
  await work.jobs.cancel('project'); await member.app.projectWork.jobs.sweep('project');
  const run = await f.waitFor(async () => (await work.jobs.runs('project')).find(run => run.taskId === receipt.taskId)!, run => run.conclusion === 'cancelled');
  expect(run.deviceId).toBe(member.deviceId); expect(run.cancelRequestedAt).toBeDefined();
  await member.app.projectWork.jobs.sweep('project'); expect((await work.jobs.runs('project')).filter(row => row.taskId === receipt.taskId)).toHaveLength(1);
});

test('retained command jobs expose an outer workspace, a pinned checkout and an isolated home within it', async () => {
  const f = fixture = await projectFixture();
  let job = await command(f, 'outer_workspace', [], 'test "$PWD" = "$JEVELLAN_JOB_WORKSPACE/checkout" && test "$HOME" = "$JEVELLAN_JOB_WORKSPACE/home" && test "$(git rev-parse HEAD)" = "$JEVELLAN_JOB_COMMIT" && printf \'{"schema":"project-job-findings-v1","findings":[{"title":"Workspace contract","brief":"Review the completed command result."}]}\' > "$JEVELLAN_JOB_WORKSPACE/project-job-findings.json"');
  if (job.run.kind !== 'command') throw new Error('Expected a command job.');
  job = await f.app.projectWork.daily.updateJob('project', job.id, { schema: 'job-update-request-v1', expectedRevision: job.revision, name: job.name, goalId: null, enabled: true, gate: null, run: { ...job.run, cwd: 'workspace' } });
  const receipt = await f.app.projectWork.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'outer_workspace_run' });
  await f.app.projectWork.dispatcher.sweep('project');
  const run = await f.waitFor(async () => (await f.app.projectWork.jobs.runs('project')).find(row => row.taskId === receipt.taskId), row => !!row?.conclusion);
  expect(run?.conclusion).toBe('passed'); expect(run?.findings).toEqual([{ title: 'Workspace contract', brief: 'Review the completed command result.' }]);
});

test('rollback runs its approved driver while the older application has no deploy script', async () => {
  const { writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { derivedId } = await import('../packages/projects/dist/index.js');
  const f = fixture = await projectFixture(), work = f.app.projectWork; await work.coordinators.ensureAssigned('project');
  const previous = f.git(f.checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(f.checkout, 'driver.mjs'), `import fs from 'node:fs'; const e=process.env; if(fs.existsSync('driver.mjs')) throw new Error('Expected the older application tree'); fs.writeFileSync(e.JEVELLAN_JOB_WORKSPACE+'/project-deploy-job-result.json',JSON.stringify({schema:'project-deploy-job-result-v1',mode:e.JEVELLAN_JOB_MODE,commit:e.JEVELLAN_JOB_COMMIT,previousCommit:e.JEVELLAN_DEPLOY_PREVIOUS_COMMIT,rollbackAvailable:true,releaseStarted:true,released:true,migrationChanged:false,missing:[],summary:'Trusted driver executed the older pinned application'}));`);
  f.git(f.checkout, 'add', 'driver.mjs'); f.git(f.checkout, 'commit', '-m', 'Add a trusted fixture driver'); f.git(f.checkout, 'push', 'origin', 'main'); const main = f.git(f.checkout, 'rev-parse', 'HEAD');
  const job = await command(f, 'rollback_driver', [], 'node "$JEVELLAN_JOB_COMMAND_CHECKOUT/driver.mjs"');
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, deploy: { ...settings.deploy, jobId: job.id } }, settings.revision);
  const taskId = 'task_rollback_driver', runId = derivedId('jrun', taskId);
  await f.app.projectHub.putDeploy(ProjectDeploySchema.parse({ schema: 'project-deploy-v1', id: 'deploy_driver', projectId: 'project', revision: 0, state: 'running', commit: main, previousCommit: previous, threads: [], suite: { commit: main, conclusion: null }, health: { before: [], after: [] }, checks: [], rollbackAvailable: true, decisionId: 'driver_decision', rollbackPending: { reason: 'owner', checkName: 'owner request', taskId, jobRunId: runId, at }, createdAt: at, updatedAt: at }), 0);
  const task = await work.tasks.save(ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id: taskId, projectId: 'project', revision: 0, title: 'Roll back fixture', brief: 'Run only the harmless fixture driver.', kind: 'job', type: 'fix', goalId: null, source: 'owner', state: 'queued', rank: '8', ownerRanked: false, now: false, after: [], needs: [], dailyId: null, jobId: job.id, threadId: null, jobRunId: null, fixed: {}, deployment: { deployId: 'deploy_driver', mode: 'rollback', commit: previous, commandCommit: main, previousCommit: main }, createdAt: at, updatedAt: at }));
  await work.jobs.start(task); const run = await f.waitFor(async () => (await work.jobs.runs('project')).find(run => run.id === runId)!, row => !!row?.conclusion);
  expect(run.conclusion).toBe('passed'); expect(run.commit).toBe(previous); expect(run.deployResult?.summary).toContain('older pinned application'); expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(main);
});
