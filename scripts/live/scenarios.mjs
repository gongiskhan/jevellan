#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LiveConfigSchema, LiveStateSchema, ScenarioRecorder, evidenceRedactor, canStart, gatingPlan, loadState, saveState } from './contracts.mjs';
import { OwnerClient, blocked } from './client.mjs';
import { preflight, prepareSandbox, resetSandbox, testCompactionReady } from './setup.mjs';
import { scenarioA } from './scenario-a.mjs';
import { scenarioB } from './scenario-b.mjs';
import { scenarioC } from './scenario-c.mjs';
import { scenarioD } from './scenario-d.mjs';

export function planFor(scenario, coordinator, layout, failingSuite) {
  if (!['A', 'B', 'C', 'D', 'all'].includes(scenario) || !['claude', 'codex'].includes(coordinator)) throw new Error('Use --scenario A|B|C|D|all and --coordinator claude|codex.');
  if (scenario === 'all') return gatingPlan(coordinator);
  if (scenario === 'D' && !layout) return ['phone-light', 'phone-dark', 'desktop-light', 'desktop-dark'].map(layout => ({ scenario, coordinator, layout }));
  if (layout && !['phone-light', 'phone-dark', 'desktop-light', 'desktop-dark'].includes(layout)) throw new Error('Use phone-light, phone-dark, desktop-light or desktop-dark.');
  return [{ scenario, coordinator, ...(layout ? { layout } : {}), ...(failingSuite ? { failingSuite: true, gating: false } : {}) }];
}
export async function collectUsage(client, projectId, recorder, since) {
  for (const thread of (await client.work(projectId)).threads) await client.watch(projectId, thread.id);
  // watch waits for each stream's initial ledger cursor, including delayed replay batches.
  const rows = [...client.events].filter(([key]) => key.startsWith(`${projectId}:`));
  for (const [key, events] of rows) for (const end of events.filter(row => ['coordinator-turn-end', 'thread-turn-end', 'project-session-end'].includes(row.type) && Date.parse(row.t) >= since)) {
    const start = events.find(row => row.turn === end.turn && ['coordinator-turn-start', 'thread-turn-start'].includes(row.type));
    const usage = end.data.usage;
    recorder.receipt.sessions.push({ key: end.data.sessionKey ?? `${key}:${end.id}`, runtime: end.data.runtime ?? start?.data.runtime ?? 'unknown', model: end.data.model ?? start?.data.model ?? start?.data.modelLabel ?? 'unknown',
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costUsd: usage?.costUsd ?? null, costSource: usage?.costSource ?? 'unknown',
      seconds: Math.max(0, (Date.parse(end.data.endedAt ?? end.t) - Date.parse(end.data.startedAt ?? start?.t ?? end.t)) / 1000) });
  }
  const grouped = new Map();
  for (const row of recorder.receipt.sessions) { const previous = grouped.get(row.key); if (!previous) grouped.set(row.key, { ...row }); else { previous.seconds += row.seconds; for (const field of ['inputTokens', 'outputTokens', 'costUsd']) previous[field] = previous[field] === null || row[field] === null ? null : previous[field] + row[field]; if (row.costSource !== 'reported') previous.costSource = row.costSource; } }
  recorder.receipt.sessions = [...grouped.values()];
  recorder.receipt.observations.push('Usage records come from runtime-reported turn outcomes. Missing tokens or cost remain unknown; minutes include concurrent sessions.');
}
export async function runLive({ plan, config, state, secrets, output = 'docs/acceptance/scenarios', connect = OwnerClient.connect, setup = resetSandbox, check = preflight, implementations = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD }, clock = Date.now }) {
  const results = [];
  for (const item of plan) {
    const recorder = new ScenarioRecorder({ ...item, output: config?.output ?? output, state, secrets: Object.values(secrets).filter(value => typeof value === 'string'), now: clock }); let client, error;
    try {
      if (!config) throw blocked('The private live configuration and owner browser sign-in are not ready. Owner reported some activation inputs pending; no real scenario started.');
      if (!canStart(state, clock())) throw blocked('The ten-hour live time box ended. Do not start another scenario; finish the handoff.');
      client = await connect(config, item.layout); recorder.clean = evidenceRedactor([...Object.values(secrets), ...client.secrets]);
      const available = await check(client, item.coordinator, secrets); if (available.gaps.length) throw blocked(available.gaps.join('\n'));
      if (item.scenario === 'C') testCompactionReady(config);
      if (item.scenario === 'B' && (!state.lastA?.passed || state.lastA.projectId !== state.projectId || state.lastA.coordinator !== item.coordinator))
        throw blocked('B continues a successful A on the same project and coordinator; no intervening reset or fabricated A state is allowed.');
      if (item.scenario !== 'B') prepareSandbox(config);
      if (item.scenario !== 'B') state.lastA = null;
      const projectId = item.scenario === 'B' ? state.lastA.projectId : await setup(client, state, item.coordinator, available.models, secrets);
      await client.watch(projectId); recorder.begin(projectId); saveState(config.stateFile, state);
      await implementations[item.scenario](client, projectId, recorder, { ...secrets, jevModel: available.jevModel, ...item });
    } catch (failure) { error = failure; if (!recorder.receipt.steps.length && !failure.blocked) recorder.receipt.observations.push(`Setup failed: ${failure.message}`); }
    finally {
      process.stdout.write(`${item.scenario}: collecting runtime usage\n`);
      if (client && recorder.receipt.startedAt) await collectUsage(client, recorder.receipt.projectId, recorder, Date.parse(recorder.receipt.startedAt)).catch(failure => recorder.receipt.observations.push(`Usage collection incomplete: ${failure.message}`));
      process.stdout.write(`${item.scenario}: closing owner readers\n`);
      await client?.close().catch(failure => { recorder.receipt.observations.push(`Owner reader cleanup incomplete: ${failure.message}`); error ??= failure; });
      process.stdout.write(`${item.scenario}: owner readers closed\n`);
    }
    const result = recorder.finish(error ? [error.message] : []); results.push(result);
    if (item.scenario === 'A' && recorder.receipt.projectId) state.lastA = { passed: result.receipt.passed, projectId: recorder.receipt.projectId, receipt: result.file, coordinator: item.coordinator };
    if (item.scenario === 'A' && item.gating !== false && !result.receipt.passed) state.consecutiveAB = 0;
    if (item.scenario === 'B' && item.gating !== false) state.consecutiveAB = result.receipt.passed && state.lastA?.passed && state.lastA.coordinator === 'claude' ? state.consecutiveAB + 1 : 0;
    if (item.scenario === 'C') state.consecutiveC = result.receipt.passed ? state.consecutiveC + 1 : 0;
    if (item.scenario === 'D' && result.receipt.passed && !state.dLayouts.includes(item.layout)) state.dLayouts.push(item.layout);
    if (config) saveState(config.stateFile, state);
    process.stdout.write(`${item.scenario}${item.layout ? ` (${item.layout})` : ''}: ${result.receipt.passed ? 'passed' : error?.blocked ? 'blocked' : 'failed'} — ${result.file}\n`);
    if (!result.receipt.passed && config) break;
  }
  return results;
}
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { scenario: { type: 'string', default: 'all' }, coordinator: { type: 'string', default: 'claude' }, config: { type: 'string' }, layout: { type: 'string' }, prepare: { type: 'boolean' }, 'failing-suite': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { process.stdout.write('node scripts/live/scenarios.mjs --scenario {A|B|C|D|all} --coordinator {claude|codex} [--config /private/config.json] [--prepare]\nSecrets are entered only through Jevellan Settings or dedicated test environment variables.\n'); return []; }
  const plan = planFor(values.scenario, values.coordinator, values.layout, values['failing-suite']); let config;
  const path = values.config ?? process.env.JEVELLAN_LIVE_CONFIG; if (path) config = LiveConfigSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
  const state = config ? loadState(config.stateFile) : LiveStateSchema.parse({ schema: 'live-scenarios-state-v1' });
  const secrets = { jevKey: process.env.JEVELLAN_TEST_JEV_KEY, visionToken: process.env.JEVELLAN_TEST_CLAUDE_TOKEN, githubToken: process.env.JEVELLAN_TEST_GITHUB_TOKEN };
  if (values.prepare) { if (!config) throw blocked('Preparation needs the private live config.'); const client = await OwnerClient.connect(config); try { const available = await preflight(client, values.coordinator, secrets); if (available.gaps.length) throw blocked(available.gaps.join('\n')); state.baseline = prepareSandbox(config); saveState(config.stateFile, state); } finally { await client.close(); } }
  const results = await runLive({ plan, config, state, secrets }); if (results.some(result => !result.receipt.passed)) process.exitCode = 1; return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.blocked ? 'Blocked' : 'Failed'}: ${error.message}\n`); process.exitCode = 1; });
