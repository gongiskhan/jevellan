import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { OwnerClient, command, git, empty } from './client.mjs';
import { newId, evidenceRedactor } from './contracts.mjs';
import { registerSandboxProject } from './setup.mjs';
import { CacheClockSchema, cacheHitRatio, measuredWindows } from './cache-checks.mjs';
import { collectUsage } from './scenarios.mjs';
const minutes = n => n * 60000;
export const CacheWindowsReceiptSchema = z.strictObject({ schema: z.literal('cache-window-check-v1'), label: z.literal('live'), attempt: z.literal('direct-context'),
  sourceCommit: z.string().length(40), startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(), deadlineAt: z.iso.datetime(), clockStartedAt: z.iso.datetime(),
  passed: z.boolean(), ownerAcceptance: z.literal(false), materialSha256: z.string().length(64), materialChars: z.number(), contextSizing: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())), errors: z.array(z.string()), observations: z.array(z.string()), windows: z.record(z.string(), z.number().nullable()), sessions: z.array(z.unknown()) });
export function cacheWindowDeadline(clock, now = Date.now()) {
  assert(clock.liveStartedAt && clock.liveDeadlineAt, 'The existing cache live clock is required. Never create another clock.');
  assert(Date.parse(clock.liveDeadlineAt) - now > minutes(75), 'At least75 minutes must remain for the70-minute probe.');
  return Date.parse(clock.liveDeadlineAt);
}
export async function runCacheWindows({ config, available, secrets, clockFile, output = 'docs/acceptance/cache-live' }) {
  const clock = CacheClockSchema.parse(JSON.parse(readFileSync(clockFile))), deadline = cacheWindowDeadline(clock), client = await OwnerClient.connect(config);
  const sourceCommit = command('git', ['rev-parse', 'HEAD']), clean = evidenceRedactor([...Object.values(secrets), ...client.secrets]), startedAt = new Date().toISOString();
  const source = ['src/invoices/index.ts', 'src/customers/index.ts', 'src/web/server.ts'].map(file => `File: ${file}\n${git(config.proCheckout, ['show', `sandbox-baseline:${file}`])}`).join('\n\n');
  const material = source.repeat(Math.ceil(170000 / source.length)).slice(0, 170000);
  const receipt = CacheWindowsReceiptSchema.parse({ schema: 'cache-window-check-v1', label: 'live', attempt: 'direct-context', sourceCommit, startedAt, endedAt: null, deadlineAt: clock.liveDeadlineAt, clockStartedAt: clock.liveStartedAt,
    passed: false, ownerAcceptance: false, materialSha256: createHash('sha256').update(material).digest('hex'), materialChars: material.length,
    contextSizing: 'Fixed170000-character sandbox source in file order, delivered directly in the owner input so none can be skipped; every actual native context must exceed60000 tokens.', rows: [], errors: [], observations: [], windows: {}, sessions: [] });
  const file = join(output, startedAt.slice(0, 10), 'cache-windows-direct.json'); mkdirSync(dirname(file), { recursive: true });
  const save = () => writeFileSync(file, JSON.stringify(CacheWindowsReceiptSchema.parse(clean(receipt)), null, 2) + '\n'); save();
  const recorder = { receipt: { messages: [], toolCalls: [], observations: receipt.observations } };
  const projects = [], pending = [], budget = amount => { assert(Date.now() < deadline, 'The original three-hour live deadline ended.'); return Math.min(amount, deadline - Date.now()); };
  const wait = async until => { while (Date.now() < until) { budget(1); await sleep(Math.min(45000, until - Date.now())); } };
  try {
    // Each native prefix has its own checkout. No shared-prefix experiment or provider keepalive.
    for (const runtime of ['claude', 'codex']) for (const idleMinutes of [3, 15, 55, 70]) {
      const projectId = newId('cache_direct'), path = join(dirname(config.proCheckout), projectId); assert(!existsSync(path));
      git(dirname(path), ['clone', '--shared', config.proCheckout, path]); git(path, ['remote', 'set-url', 'origin', 'https://github.com/gongiskhan/jevellan-live-sandbox.git']);
      await registerSandboxProject(client, { schema: 'project-v1', id: projectId, name: `${runtime} cache ${idleMinutes}`, remoteUrl: 'https://github.com/gongiskhan/jevellan-live-sandbox.git', paths: { [config.proDeviceId]: path }, branchPolicy: 'external',
        allowedDevices: [config.proDeviceId], githubTokenScope: config.githubTokenScope, memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, secrets);
      await client.settings(projectId, { coordinator: { runtimeId: runtime, accountId: null, modelId: available.models[runtime].id, effort: 'low' }, sessionCheckpoints: { enabled: false, checkpointMinTokens: 40000 },
        memory: { mode: 'device', capture: false, dreamMode: 'apply' }, refill: { enabled: false, minIntervalMinutes: 30 }, nightlyWindow: { enabled: false, time: '23:59', timezone: 'UTC' } });
      projects.push({ projectId, runtime, idleMinutes });
    }
    await Promise.all(projects.map(async probe => {
      const { projectId, runtime, idleMinutes } = probe;
      try {
        await client.owner(projectId, `For this isolated cache measurement, read the following fixed sandbox context and answer one short question: name one business-domain module it contains. Create no tasks and change nothing.\n\n${material}`, recorder, budget(minutes(12)));
        const first = client.ledger(projectId).findLast(event => event.type === 'session-turn-cache'), firstEnd = client.ledger(projectId).findLast(event => event.type === 'coordinator-turn-end');
        assert(first?.data.contextTokensAfter >= 60000, `The complete fixed input produced fewer than60000 context tokens: ${first?.data.contextTokensAfter}.`);
        const initial = { runtime, model: first.data.model, projectId, idleMinutes, initialAt: first.data.at, activityAt: first.data.activityAt, contextTokens: first.data.contextTokensAfter };
        pending.push(initial); receipt.observations.push(`${runtime}/${idleMinutes}: fixed context loaded (${initial.contextTokens} native context tokens).`); save();
        await wait(Date.parse(first.data.activityAt) + minutes(idleMinutes));
        await client.owner(projectId, 'Name that business-domain module again. Answer briefly; create no tasks and change nothing.', recorder, budget(minutes(10)));
        const followup = client.ledger(projectId).findLast(event => event.type === 'session-turn-cache'), ended = client.ledger(projectId).findLast(event => event.type === 'coordinator-turn-end');
        assert(followup.id > first.id); assert.equal(ended.data.sessionKey, firstEnd.data.sessionKey, 'The native cache probe must keep the same session.');
        assert(client.ledger(projectId).filter(event => event.type === 'session-turn-cache').length === 2, 'No intervening model request or keepalive is allowed.');
        assert(followup.data.idleSeconds >= idleMinutes * 60 && followup.data.idleSeconds <= idleMinutes * 60 + 120, 'Actual idle must stay within two minutes of the planned idle.');
        const hitRatio = cacheHitRatio(followup.data); assert(hitRatio !== null, 'Actual follow-up usage must be reported.');
        receipt.rows.push({ ...initial, followupAt: followup.data.at, actualIdleSeconds: followup.data.idleSeconds, hitRatio, cacheReadTokens: followup.data.cacheReadTokens,
          cacheWriteTokens: followup.data.cacheWriteTokens, cacheWritesKnown: followup.data.cacheWritesKnown, uncachedInputTokens: followup.data.uncachedInputTokens }); receipt.windows = measuredWindows(receipt.rows); save();
      } catch (error) { receipt.errors.push(clean(`${runtime}/${idleMinutes}: ${error.message}`)); save(); }
    }));
    assert.equal(receipt.rows.length, 8, 'Every one of the eight timed follow-ups must be recorded.');
    assert.equal(receipt.errors.length, 0); receipt.passed = true;
  } catch (error) { receipt.errors.push(clean(error.message)); }
  finally {
    for (const { projectId } of projects) {
      const usage = { receipt: { sessions: [], observations: receipt.observations } }; await collectUsage(client, projectId, usage, Date.parse(startedAt)).catch(error => receipt.observations.push(clean(error.message))); receipt.sessions.push(...usage.receipt.sessions);
      await client.call('POST', `/api/projects/${projectId}/coordinator/stop`, empty).catch(error => receipt.observations.push(clean(error.message)));
    }
    await client.close(); receipt.endedAt = new Date().toISOString(); save(); console.log(`Cache-window calibration ${receipt.passed ? 'passed' : 'failed'}: ${file}`);
  }
  void pending;
  return receipt;
}
