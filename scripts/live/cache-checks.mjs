import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { CoordinatorStateSchema, readDocument } from '../../packages/core/dist/index.js';
import { listNativeSessions, readNativeTranscript } from '../../packages/mesh/dist/index.js';
import { OwnerClient, github, git, command, remote, until } from './client.mjs';
import { newId, evidenceRedactor, LiveStateSchema } from './contracts.mjs';
import { resetSandbox, registerSandboxProject, stopSandboxWork } from './setup.mjs';
import { mergeWhenAsked } from './scenario-a.mjs';
import { threadJournalFile } from '../../packages/projects/dist/index.js';
import { collectUsage } from './scenarios.mjs';

const hash = text => createHash('sha256').update(text).digest('hex'), minutes = n => n * 60000;
export const CacheClockSchema = z.strictObject({ schema: z.literal('cache-journal-clock-v1'), release: z.literal('0.3.4'), priorClosingCommit: z.string().length(40),
  buildStartedAt: z.iso.datetime(), buildDeadlineAt: z.iso.datetime(), liveStartedAt: z.iso.datetime().nullable(), liveDeadlineAt: z.iso.datetime().nullable(), overallDeadlineAt: z.iso.datetime(), checkpointDefault: z.boolean() });
export const CacheCheckReceiptSchema = z.strictObject({ schema: z.literal('cache-live-checks-v1'), label: z.literal('live'), release: z.literal('0.3.4'), sourceCommit: z.string().length(40),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(), deadlineAt: z.iso.datetime(), ownerAcceptance: z.literal(false),
  passed: z.boolean(), checks: z.array(z.strictObject({ name: z.enum(['L1', 'L2', 'L3']), verdict: z.enum(['passed', 'failed', 'blocked', 'not run']),
    startedAt: z.iso.datetime().nullable(), endedAt: z.iso.datetime().nullable(), reason: z.string().optional(), evidence: z.record(z.string(), z.unknown()) })),
  observations: z.array(z.string()), projects: z.array(z.string()), sessions: z.array(z.unknown()), messages: z.array(z.unknown()), toolCalls: z.array(z.unknown()), pullRequests: z.array(z.number()), providerTotals: z.record(z.string(), z.unknown()), minutes: z.number() });
export function cacheHitRatio(row) { if (!row?.usageKnown) return null; const total = row.cacheReadTokens + row.cacheWriteTokens + row.uncachedInputTokens; return total ? row.cacheReadTokens / total : null; }
export function measuredWindows(rows) { return Object.fromEntries(['claude', 'codex'].map(runtime => [runtime, Math.max(0, ...rows.filter(row => row.runtime === runtime && row.hitRatio !== null && row.hitRatio >= .8).map(row => row.idleMinutes)) || null])); }
async function coTranscript(config, projectId) {
  const state = readDocument(join(config.hubHome, 'projects', projectId, 'coordinator.json'), CoordinatorStateSchema), session = state.session;
  assert(session?.nativeSessionId, 'The current coordinator must have a real native session.');
  const root = join(config.hubHome, 'homes', session.runtime, session.accountId), runtime = session.runtime;
  const journal = (await listNativeSessions({ runtime, root })).find(row => row.nativeId === session.nativeSessionId); assert(journal, 'The coordinator native transcript must exist.');
  return readNativeTranscript({ runtime, root, file: journal.file, sessionId: session.nativeSessionId, deviceId: config.proDeviceId, deviceName: 'Pro', title: 'Cache checkpoint', project: 'Live cache' });
}
export async function runCacheChecks({ config, available, secrets, clockFile, output = 'docs/acceptance/cache-live' }) {
  const clock = CacheClockSchema.parse(JSON.parse(readFileSync(clockFile))), client = await OwnerClient.connect(config), clean = evidenceRedactor([...Object.values(secrets), ...client.secrets]);
  const sourceCommit = command('git', ['rev-parse', 'HEAD']), startedAt = new Date().toISOString();
  assert(!existsSync(join(config.hubHome, 'install.json')), 'Use the uninstalled real-provider profile.');
  assert.equal(process.env.JEVELLAN_TEST_CACHE_WINDOW_MINUTES, '1');
  assert.equal(clock.liveStartedAt, null, 'Never reset or restart the cache live clock.');
  clock.liveStartedAt = startedAt; clock.liveDeadlineAt = new Date(Math.min(Date.now() + minutes(180), Date.parse(clock.overallDeadlineAt))).toISOString();
  writeFileSync(clockFile, JSON.stringify(clock, null, 2) + '\n', { mode: 0o600 });
  const receipt = CacheCheckReceiptSchema.parse({ schema: 'cache-live-checks-v1', label: 'live', release: '0.3.4', sourceCommit, startedAt, endedAt: null, deadlineAt: clock.liveDeadlineAt,
    ownerAcceptance: false, passed: false, checks: ['L1', 'L2', 'L3'].map(name => ({ name, verdict: 'not run', startedAt: null, endedAt: null, evidence: {} })), observations: [], projects: [], sessions: [], messages: [], toolCalls: [], pullRequests: [], providerTotals: {}, minutes: 0 });
  const path = join(output, startedAt.slice(0, 10), 'cache-checks.json'); mkdirSync(dirname(path), { recursive: true });
  const save = () => writeFileSync(path, JSON.stringify(CacheCheckReceiptSchema.parse(clean(receipt)), null, 2) + '\n');
  const budget = amount => { const left = Date.parse(clock.liveDeadlineAt) - Date.now(); assert(left > 0, 'The three-hour cache live time box ended.'); return Math.min(amount, left); };
  const pause = async amount => { const end = Date.now() + budget(amount); while (Date.now() < end) await sleep(Math.min(45000, end - Date.now())); };
  const recorder = { receipt: { observations: receipt.observations, pullRequests: receipt.pullRequests, messages: [], toolCalls: [] }, clean };
  const projects = [], beginnings = new Map();
  const section = async (name, action) => {
    const row = receipt.checks.find(row => row.name === name); row.startedAt = new Date().toISOString(); save(); console.log(`${name}: started`);
    try { row.evidence = await action(); row.verdict = 'passed'; } catch (error) { row.verdict = error.blocked ? 'blocked' : 'failed'; row.reason = clean(error.message); }
    finally { row.endedAt = new Date().toISOString(); save(); console.log(`${name}: ${row.verdict}${row.reason ? ' — ' + row.reason : ''}`); }
  };
  try {
    const state = LiveStateSchema.parse({ schema: 'live-scenarios-state-v1' });
    const projectId = await resetSandbox(client, state, 'claude', available.models, secrets); projects.push(projectId); beginnings.set(projectId, Date.now()); receipt.projects.push(projectId);
    await client.settings(projectId, { sessionCheckpoints: { enabled: true, checkpointMinTokens: 40000 }, memory: { mode: 'hub', capture: false, dreamMode: 'apply' } });
    const l1 = newId('cache_windows');
    await registerSandboxProject(client, { schema: 'project-v1', id: l1, name: 'Cache window measurements', remoteUrl: 'https://github.com/gongiskhan/jevellan-live-sandbox.git',
      paths: { [config.proDeviceId]: config.proCheckout, [config.madridDeviceId]: config.madridCheckout }, branchPolicy: 'external', allowedDevices: [config.proDeviceId, config.madridDeviceId],
      githubTokenScope: config.githubTokenScope, memory: { mode: 'hub', dir: '.jevellan/memory' }, context: { state: 'none' } }, secrets);
    projects.push(l1); beginnings.set(l1, Date.now()); receipt.projects.push(l1);
    await client.settings(l1, { defaultIsolation: 'worktree', allowMainIsolation: false, setupCommand: null, autoMerge: false,
      coordinator: { runtimeId: null, accountId: null, modelId: 'cache-measurements-no-coordinator', effort: 'low' }, maxRunningThreads: 12, maxRunningPerDevice: 8,
      sessionCheckpoints: { enabled: false, checkpointMinTokens: 40000 }, memory: { mode: 'hub', capture: false, dreamMode: 'apply' }, refill: { enabled: false, minIntervalMinutes: 30 } });
    save();
    const l1Promise = section('L1', async () => {
      const material = ['src/invoices/index.ts', 'src/customers/index.ts', 'src/web/server.ts'].map(file => git(config.proCheckout, ['show', `sandbox-baseline:${file}`])).join('\n\n');
      // Same immutable source bytes/order on both devices. Token sizing is explicit rather than an invented provider count.
      const content = material.repeat(Math.ceil(240000 / material.length)).slice(0, 240000), chunks = Array.from({ length: 20 }, (_, i) => content.slice(i * 12000, (i + 1) * 12000));
      const folder = join(config.proCheckout, 'node_modules', '.jevellan-cache-context'); mkdirSync(folder, { recursive: true });
      chunks.forEach((text, i) => writeFileSync(join(folder, `${i + 1}.txt`), text));
      remote(config, `import{mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';mkdirSync(payload.folder,{recursive:true});payload.chunks.forEach((text,i)=>writeFileSync(join(payload.folder,(i+1)+'.txt'),text));console.log('Fixed cache context ready.');`, { folder: join(config.madridCheckout, 'node_modules', '.jevellan-cache-context'), chunks });
      const measurements = [];
      const tasks = await Promise.all(['claude', 'codex'].flatMap(runtime => [3, 15, 55, 70].map(async (idleMinutes, i) => {
        const deviceId = i % 2 ? config.madridDeviceId : config.proDeviceId, root = deviceId === config.proDeviceId ? config.proCheckout : config.madridCheckout;
        const brief = `Read the twenty fixed context files ${join(root, 'node_modules', '.jevellan-cache-context')}/{1..20}.txt in numerical order, reading every file in full before answering. The files repeat sandbox source for an isolated cache measurement. Change nothing, run no tests, commit nothing and open no pull request. Answer this short question: which business-domain modules appear in the source? End with jevellan_thread_report status blocked, summary containing your answer. You are waiting for a later follow-up; do not ask the owner a question.`;
        const task = await client.task(l1, `Cache ${runtime} ${idleMinutes} minutes`, brief, { runtimeId: runtime, modelId: available.models[runtime].id, deviceId, effort: 'low' });
        return { task, runtime, idleMinutes, deviceId };
      })));
      const settled = await Promise.allSettled(tasks.map(async row => {
        const task = await until('a cache measurement thread', async () => (await client.tasks(l1)).find(t => t.id === row.task.taskId && t.threadId), budget(minutes(15)));
        await client.watch(l1, task.threadId);
        const first = await until('the cache context turn to finish', () => client.ledger(l1, task.threadId).find(event => event.type === 'session-turn-cache'), budget(minutes(20)));
        const end = await until('the initial cache turn outcome', () => client.ledger(l1, task.threadId).find(event => event.type === 'thread-turn-end' && event.turn === first.turn), budget(minutes(2)));
        const due = Date.parse(first.data.activityAt) + minutes(row.idleMinutes); if (Date.now() < due) await pause(due - Date.now());
        await client.call('POST', `/api/projects/${l1}/threads/${task.threadId}/messages`, { schema: 'thread-message-request-v1', clientMessageId: newId('cache_followup'), text: 'Name one of those business-domain modules again. Change nothing and end with a blocked thread report, as before.', interrupt: false });
        const followup = await until('the timed follow-up cache receipt', () => client.ledger(l1, task.threadId).find(event => event.type === 'session-turn-cache' && event.id > first.id), budget(minutes(15)));
        const latest = await until('the follow-up cache turn outcome', () => client.ledger(l1, task.threadId).find(event => event.type === 'thread-turn-end' && event.turn === followup.turn), budget(minutes(2)));
        assert.equal(latest?.data.sessionKey, end?.data.sessionKey, 'A cache probe must resume the same native session.');
        const hitRatio = cacheHitRatio(followup.data); assert(hitRatio !== null, 'The runtime must report follow-up usage.');
        measurements.push({ runtime: row.runtime, idleMinutes: row.idleMinutes, actualIdleSeconds: followup.data.idleSeconds, threadId: task.threadId,
          hitRatio, contextTokens: first.data.contextTokensAfter, cacheReadTokens: followup.data.cacheReadTokens, cacheWriteTokens: followup.data.cacheWriteTokens, cacheWritesKnown: followup.data.cacheWritesKnown, uncachedInputTokens: followup.data.uncachedInputTokens });
        receipt.checks[0].evidence = { materialSha256: hash(content), materialChars: content.length, sourceSizing: '240000 characters targeting60000 tokens; actual session context checked separately', measurements, windows: measuredWindows(measurements) }; save();
      }));
      const failed = settled.filter(row => row.status === 'rejected'); assert.equal(failed.length, 0, failed.map(row => row.reason.message).join('\n'));
      assert.equal(measurements.length, 8); assert(measurements.every(row => row.contextTokens >= 60000), 'Each fixed source read must fill at least60,000 context tokens; actual contexts are recorded.'); return { materialSha256: hash(content), measurements, windows: measuredWindows(measurements) };
    });
    await section('L2', async () => {
      await client.owner(projectId, 'Add a CSV export to the customers page', recorder, budget(minutes(15)));
      const seed = await until('CSV export to reach a merged pull request', async () => {
        const task = (await client.tasks(projectId)).find(task => /csv|export/iu.test(task.title)); if (!task?.threadId) return;
        await client.watch(projectId, task.threadId); const view = await client.thread(projectId, task.threadId); if (!view.thread.pr) return;
        await mergeWhenAsked(client, projectId, task.threadId, recorder); return view.thread.pr.state === 'merged' && view.thread.state === 'done' ? view : undefined;
      }, budget(minutes(45)), 5000);
      await client.owner(projectId, "From now on, start the title of every invoice task with 'Invoices:'.", recorder, budget(minutes(15)));
      const logs = [];
      for (const run of github('actions/runs?per_page=15').workflow_runs) { for (const job of github(`actions/runs/${run.id}/jobs?per_page=100`).jobs) {
        try { logs.push(command('gh', ['api', `repos/gongiskhan/jevellan-live-sandbox/actions/jobs/${job.id}/logs`])); } catch { /* Expired real logs remain unavailable. */ }
        if (logs.length >= 3) break;
      } if (logs.length >= 3) break; }
      assert(logs.some(text => /test|vitest/iu.test(text)), 'Real CI logs are required; no synthetic replacement.');
      for (let i = 0; i < 8 && (await client.work(projectId)).coordinator.session.context.tokens < 40000; i++) await client.owner(projectId, "Here's last week's CI log, anything worrying?\n" + logs.join('\n').repeat(20).slice(0, 150000), recorder, budget(minutes(15)));
      const before = (await client.work(projectId)).coordinator.session.context.tokens; assert(before >= 40000, 'The coordinator context must exceed40,000 tokens.');
      const ids = new Set((await client.tasks(projectId)).map(task => task.id)); await pause(minutes(2));
      await client.owner(projectId, 'Add a PDF download for invoices.', recorder, budget(minutes(15)));
      const checkpoint = client.ledger(projectId).findLast(event => event.type === 'session-checkpointed'); assert(checkpoint, 'A real coordinator checkpoint is required.');
      assert.notEqual(checkpoint.data.previousSessionId, checkpoint.data.newSessionId);
      const start = client.ledger(projectId).find(event => event.type === 'coordinator-turn-start' && event.turn === checkpoint.turn);
      assert(start?.data.prompt?.startsWith('This is a fresh coordinator session:')); assert(start.data.prompt.includes('Project notebook:') && start.data.prompt.includes('INDEX.md follows.'));
      const task = (await client.tasks(projectId)).find(task => !ids.has(task.id)); assert(task?.title.startsWith('Invoices:'));
      assert(checkpoint.data.firstTurnCacheWriteTokens !== null && checkpoint.data.firstTurnCacheWriteTokens < before * .25, 'Checkpoint cache writes must be below25% of previous context.');
      await client.owner(projectId, 'What happened with the CSV export work?', recorder, budget(minutes(15)));
      const transcript = await coTranscript(config, projectId), reads = transcript.turns.flatMap(turn => turn.blocks).filter(block => block.type === 'tool' && /Read/u.test(block.name));
      const file = threadJournalFile({ id: seed.thread.id, title: seed.thread.title });
      const read = reads.find(block => block.input.includes(file)); assert(read, 'The coordinator must Read the finished CSV thread journal.');
      const reply = client.ledger(projectId).findLast(event => event.type === 'coordinator-text')?.data.text; assert(reply?.includes(String(seed.thread.pr.number)));
      return { seedThread: seed.thread.id, pullRequest: seed.thread.pr.number, checkpoint: checkpoint.data, title: task.title, prompt: start.data.prompt.slice(0, 4000), journalRead: read.input, reply };
    });
    await section('L3', async () => {
      const created = await client.task(projectId, 'Paginate the customers list', 'Paginate the customers list. Before building, ask the owner for the page size: 10, 25 or 50.', { runtimeId: 'codex', deviceId: config.proDeviceId });
      const task = await until('the pagination thread', async () => (await client.tasks(projectId)).find(task => task.id === created.taskId && task.threadId), budget(minutes(10))); await client.watch(projectId, task.threadId);
      const question = await until('the pagination question', async () => (await client.work(projectId)).decisions.open.find(question => question.threadId === task.threadId), budget(minutes(20)));
      const original = await client.thread(projectId, task.threadId); await pause(minutes(2));
      await client.page.goto(`${config.hub}/projects/${projectId}`); const waiting = client.page.getByRole('button', { name: /^Waiting/u }); if (await waiting.isVisible()) await waiting.click();
      const card = client.page.locator('.pw-decision').filter({ hasText: question.question }); await card.getByRole('button', { name: '25', exact: true }).click();
      const checkpoint = await until('a real thread checkpoint after the card answer', () => client.ledger(projectId, task.threadId).find(event => event.type === 'session-checkpointed'), budget(minutes(15)));
      assert.notEqual(checkpoint.data.previousSessionId, checkpoint.data.newSessionId);
      const start = client.ledger(projectId, task.threadId).find(event => event.type === 'thread-turn-start' && event.turn === checkpoint.turn), prompt = start?.data.prompt;
      assert(prompt?.startsWith('You are continuing this task in a fresh session:')); assert(prompt.includes(question.question) && prompt.includes('25'));
      const ended = await until('pagination to reach done', async () => { await mergeWhenAsked(client, projectId, task.threadId, recorder); const view = await client.thread(projectId, task.threadId); return view.thread.state === 'done' ? view : undefined; }, budget(minutes(35)), 5000);
      assert(ended.thread.pr, 'A completed pagination change needs a pull request.');
      const files = github(`pulls/${ended.thread.pr.number}/files?per_page=100`); assert(files.some(file => /25/u.test(file.patch ?? '') && /customer|web/iu.test(file.filename)));
      git(config.proCheckout, ['fetch', 'origin']);
      const commits = github(`pulls/${ended.thread.pr.number}/commits?per_page=100`), patches = commits.map(commit => command('git', ['show', commit.sha], { cwd: config.proCheckout })).map(patch => command('git', ['patch-id', '--stable'], { input: patch })).filter(Boolean);
      assert.equal(new Set(patches.map(row => row.split(' ')[0])).size, patches.length, 'The branch must not duplicate committed patches.');
      return { taskId: task.id, threadId: task.threadId, checkpoint: checkpoint.data, prompt: prompt.slice(0, 5000), question: question.question, pullRequest: ended.thread.pr.number, beforeTurns: original.thread.turns, commits: commits.map(commit => commit.sha) };
    });
    await l1Promise;
  } catch (error) { receipt.observations.push(clean(`Setup or infrastructure: ${error.message}`)); }
  finally {
    for (const projectId of projects) {
      const usage = { receipt: { sessions: [], observations: receipt.observations } };
      await collectUsage(client, projectId, usage, beginnings.get(projectId)).catch(error => receipt.observations.push(clean(`Usage incomplete: ${error.message}`)));
      receipt.sessions.push(...usage.receipt.sessions);
      await stopSandboxWork(client, projectId).catch(error => receipt.observations.push(clean(`Cleanup incomplete: ${error.message}`)));
    }
    receipt.messages = recorder.receipt.messages.map(row => ({ ...row, owner: row.owner.slice(0, 1500), reply: row.reply.slice(0, 8000) })); receipt.toolCalls = recorder.receipt.toolCalls;
    await client.close(); receipt.endedAt = new Date().toISOString(); receipt.minutes = (Date.parse(receipt.endedAt) - Date.parse(startedAt)) / 60000;
    for (const runtime of ['claude', 'codex']) { const rows = receipt.sessions.filter(row => row.runtime === runtime); receipt.providerTotals[runtime] = { costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0), unknownCostSessions: rows.filter(row => row.costUsd === null).length, inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0), minutes: rows.reduce((sum, row) => sum + row.seconds / 60, 0) }; }
    receipt.passed = receipt.checks.every(row => row.verdict === 'passed'); save(); console.log(`Cache checks complete: ${path}`);
  }
  return receipt;
}
