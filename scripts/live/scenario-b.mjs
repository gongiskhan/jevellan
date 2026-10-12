import assert from 'node:assert/strict';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { github, git, until, blocked } from './client.mjs';
import { seedDream } from './setup.mjs';

const minutes = n => n * 60000;
export function pushFile(path, content, message) {
  const current = github(`contents/${path}?ref=main`);
  return github(`contents/${path}`, { method: 'PUT', input: { message, sha: current.sha, content: Buffer.from(content).toString('base64'), branch: 'main' } }).commit.sha;
}
export async function scenarioB(client, projectId, recorder, { failingSuite = false } = {}) {
  let ownerNote, report, review, window, suite, deploy, direct;
  const previous = await client.nightly(projectId), watermark = previous.lastReviewedCommit;
  assert(watermark, 'The review watermark must be explicit before the night.');
  await recorder.step('B-setup', 'Continue A without resetting; include a real direct push and dream candidates; open the window three minutes later with the fenced thirty-minute test cutoff.', async () => {
    if (process.env.NODE_ENV !== 'test' || process.env.JEVELLAN_TEST_NIGHTLY_FIX_MINUTES !== '30') throw blocked('B requires the uninstalled real-provider test hub with JEVELLAN_TEST_NIGHTLY_FIX_MINUTES=30; installed production keeps its 150-minute cutoff.');
    const changelog = Buffer.from(github('contents/CHANGELOG.md?ref=main').content, 'base64').toString('utf8');
    direct = pushFile('CHANGELOG.md', `${changelog}\nDirect push for the nightly test\n`, 'Record direct push for the nightly scenario');
    if (failingSuite) pushFile('src/invoices/index.test.ts', Buffer.from(github('contents/src/invoices/index.test.ts?ref=main').content, 'base64').toString('utf8') + '\ntest("nightly failure", () => { expect(1).toBe(2); });\n', 'Exercise failing nightly suite');
    ownerNote = await seedDream(client, projectId);
    await client.settings(projectId, { refill: { enabled: false, minIntervalMinutes: 10 } });
    const goals = (await client.call('GET', `/api/projects/${projectId}/goals`)).goals;
    const goal = goals.find(row => row.goal.name === 'Hardening through code review').goal;
    await client.call('POST', `/api/projects/${projectId}/goals/${goal.id}/edit`, { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'active' });
    const at = new Date(Date.now() + minutes(3)), time = at.toISOString().slice(11, 16);
    await client.settings(projectId, { nightlyWindow: { enabled: true, time, timezone: 'UTC' } });
    return { directCommit: direct, watermark, scheduledTime: time, failingSuite };
  });
  await recorder.step('B1', 'The on-time review uses the other provider and its exact watermark-to-head range includes the direct push.', async () => {
    window = await until('the configured nightly window to open', async () => (await client.nightly(projectId)).window?.state === 'open' ? (await client.nightly(projectId)).window : undefined, minutes(5));
    assert(window.scheduledAt && Math.abs(Date.parse(window.openedAt) - Date.parse(window.scheduledAt)) <= 90000);
    review = await until('the review report', async () => { const view = await client.nightly(projectId); return view.tasks.find(row => window.taskIds.includes(row.id) && row.reviewRun?.state === 'completed'); }, minutes(25));
    report = review.reviewRun.report; assert.equal(report.fromCommit, watermark);
    if (review.reviewRun.majorityProvider) assert.notEqual(report.runtime, review.reviewRun.majorityProvider);
    git(client.config.proCheckout, ['fetch', 'origin']); const commits = git(client.config.proCheckout, ['rev-list', '--reverse', `${watermark}..${report.commit}`]).split('\n').filter(Boolean); assert(commits.includes(direct));
    // The exact input is an owner-readable Jevellan artifact, not a native transcript.
    const inputPath = join(client.config.hubHome, 'project-work', projectId, 'reviews', review.id, 'changes.diff');
    const { readFileSync } = await import('node:fs'); const input = readFileSync(inputPath, 'utf8');
    const covered = [...input.matchAll(/^commit ([a-f0-9]{40})\b/gmu)].map(row => row[1]); assert.deepEqual(new Set(covered), new Set(commits));
    await client.page.goto(`${client.config.hub}/projects/${projectId}`); await client.page.getByRole('button', { name: 'Nightly', exact: true }).click(); await expect(client.page.getByText("Last night's review", { exact: true })).toBeVisible();
    return { windowId: window.id, from: watermark, head: report.commit, commits, runtime: report.runtime, majority: review.reviewRun.majorityProvider, summary: report.summary };
  });
  await recorder.step('B2', 'The coordinator chooses one review follow-up; an optional fix uses the merge gate and respects the cutoff.', async () => {
    review = await until('the coordinator to choose the review follow-up', async () => (await client.tasks(projectId)).find(row => row.id === review.id && row.reviewRun.followupChosen), minutes(20));
    const calls = client.ledger(projectId).filter(row => row.type === 'coordinator-tool' && row.data.tool === 'jevellan_review_followup' && JSON.parse(row.data.input ?? '{}').reviewTaskId === review.id); assert.equal(calls.length, 1);
    const fixId = review.reviewRun.fixTaskId; if (!fixId) return { fix: null, calls: calls.map(row => row.data) };
    const fix = await until('the nightly fix to merge or continue past the cutoff', async () => { const task = (await client.tasks(projectId)).find(row => row.id === fixId); if (!task?.threadId) return; await client.watch(projectId, task.threadId); const view = await client.thread(projectId, task.threadId); if (view.thread.pr?.state === 'merged' || Date.now() >= Date.parse(window.openedAt) + minutes(30)) return { task, view }; }, minutes(35));
    const route = await client.call('GET', `/api/projects/${projectId}/threads/${fix.task.threadId}/pr/route`); if (fix.view.thread.pr?.state === 'merged') { assert(route.records.some(row => row.schema === 'merge-route-v1' && row.commit === fix.view.thread.pr.headSha)); assert(Date.parse(fix.task.endedAt) <= Date.parse(window.openedAt) + minutes(30)); }
    return { fix: fixId, state: fix.task.state, pull: fix.view.thread.pr?.number, routes: route.records };
  });
  await recorder.step('B3', 'The suite and deploy bind to the same exact SHA in their run names and required steps; a failing suite creates no deploy.', async () => {
    const nightly = await until('the full suite to finish', async () => { const view = await client.nightly(projectId); const job = view.jobs.find(row => row.name === 'Full suite'), run = view.runs.find(row => row.jobId === job.id && row.nightlyWindowId === window.id && row.conclusion); return run ? { view, run } : undefined; }, minutes(50)); suite = nightly.run;
    assert.equal(suite.conclusion, failingSuite ? 'failed' : 'passed'); assert(suite.workflowRunId); const run = github(`actions/runs/${suite.workflowRunId}`), jobs = github(`actions/runs/${suite.workflowRunId}/jobs?per_page=100`).jobs;
    assert(run.display_title.includes(suite.commit)); assert.equal(run.event, 'workflow_dispatch'); assert(jobs.some(job => job.name === 'suite' && job.steps.some(step => step.name === 'Unit tests' && step.status === 'completed')));
    recorder.receipt.workflowRunIds.push(run.id);
    const finished = await until('the window to finish', async () => { const view = await client.nightly(projectId); return view.window?.id === window.id && view.window.state === 'finished' ? view : undefined; }, minutes(40)); window = finished.window;
    const deployJob = finished.jobs.find(row => row.name === 'Deploy'); deploy = finished.runs.find(row => row.jobId === deployJob.id && row.nightlyWindowId === window.id);
    if (failingSuite) { assert(!deploy?.workflowRunId); assert(window.failed); assert(/fail/iu.test(window.outcome)); }
    else { assert.equal(deploy?.conclusion, 'passed'); assert.equal(deploy.commit, suite.commit); const deployRun = github(`actions/runs/${deploy.workflowRunId}`); assert(deployRun.display_title.includes(suite.commit)); const deployJobs = github(`actions/runs/${deploy.workflowRunId}/jobs?per_page=100`).jobs; assert(deployJobs.some(job => job.name === 'deploy' && job.steps.some(step => step.name === 'Deploy tag' && step.conclusion === 'success'))); assert(github('git/matching-refs/tags/deployed/').some(tag => tag.object.sha === suite.commit)); recorder.receipt.workflowRunIds.push(deployRun.id); }
    return { tested: suite.commit, suiteRun: run.id, suiteUrl: run.html_url, conclusion: suite.conclusion, deployed: deploy?.commit, deployRun: deploy?.workflowRunId };
  });
  await recorder.step('B4', 'The dream consolidates durable notes, corrects or archives stale knowledge, protects the owner note and computes its counts from the committed changes.', async () => {
    const memory = await until('the dream to apply', async () => { const view = await client.memory(projectId); return view.dream?.state === 'applied' && Date.parse(view.dream.startedAt) >= Date.parse(window.openedAt) - 10000 ? view : undefined; }, minutes(120)); const dream = memory.dream.report;
    const active = memory.notes.filter(note => !/^status:\s*archived/mu.test(note.content)); assert.equal(active.filter(note => /^(?:Build commands|Unit suite)$/u.test(note.title)).length, 1);
    const legacy = memory.notes.find(note => note.title === 'Legacy report'); if (legacy) assert(!legacy.content.includes('src/legacy/report.ts') || /^status:\s*archived/mu.test(legacy.content) && /archiveReason:/u.test(legacy.content));
    assert.equal(memory.notes.find(note => note.title === 'Owner note')?.content, ownerNote); assert(!memory.inbox.some(note => /thread X is halfway through|waiting for CI/u.test(note.content)));
    assert(active.some(note => /CHANGELOG/u.test(note.content))); const brief = active.find(note => note.title === 'Project brief'); assert(brief && /npm test/u.test(brief.content) && /CHANGELOG/u.test(brief.content));
    const root = join(client.config.hubHome, 'project-memory', projectId, 'notes'); const changed = git(root, ['diff', '--name-only', dream.fromCommit, dream.toCommit]).split('\n').filter(Boolean);
    for (const change of dream.changes) assert(changed.includes(`${change.note}.md`) || changed.includes(change.note), `Dream change ${change.note} must exist in its commit diff.`);
    const counts = { inboxPromoted: 0, inboxDropped: 0, merged: 0, corrected: 0, archived: 0, created: 0 };
    for (const change of dream.changes) { if (change.note.startsWith('inbox/')) counts[change.action === 'merged' ? 'inboxPromoted' : 'inboxDropped']++; else counts[{ created: 'created', updated: 'corrected', merged: 'merged', archived: 'archived', dropped: 'archived' }[change.action]]++; }
    assert.deepEqual(dream.counts, counts); recorder.receipt.notes.push(...dream.changes.map(row => row.note)); return { dreamId: dream.dreamId, from: dream.fromCommit, to: dream.toCommit, changed, counts, summary: dream.summary };
  });
  await recorder.step('B5', 'The completed night report and morning reply cover review, fix, suite, deployed SHA and dream; failed nights are mirrored when the optional Ekoa input is configured.', async () => {
    const latest = await client.nightly(projectId); assert.equal(latest.window.state, 'finished'); assert(latest.window.outcome.includes(suite.commit)); assert(/Review|review/u.test(latest.window.outcome) && /Memory dream/u.test(latest.window.outcome));
    const turn = await client.owner(projectId, 'How did the night go?', recorder); assert(/review/iu.test(turn.reply) && /fix|finding|none|no .*(?:task|issues)/iu.test(turn.reply) && /suite|tests/iu.test(turn.reply) && /dream|memory/iu.test(turn.reply)); if (!failingSuite) assert(turn.reply.includes(suite.commit.slice(0, 7)));
    if (failingSuite && client.config.ekoaLabel) { const state = await until('the Ekoa failed-night mirror', async () => { const state = await client.call('GET', '/hub/ekoa'); return state.mirrors.find(row => row.projectId === projectId && row.kind === 'night-report' && row.ekoaTaskId) ? state : undefined; }, minutes(5)); const item = state.mirrors.find(row => row.projectId === projectId && row.kind === 'night-report'); assert(/night report/iu.test(item.title)); return { reply: turn.reply, report: latest.window.outcome, mirror: item.ekoaTaskId }; }
    if (failingSuite) recorder.receipt.observations.push('Blocked: optional Ekoa mirror assertion; the owner has not supplied the test label/connection.');
    return { reply: turn.reply, report: latest.window.outcome };
  });
}
