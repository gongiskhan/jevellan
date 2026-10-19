// The bridge behaviour eval (bridge specification, "Testing", item 7). Real model, opt-in: JEVELLAN_BRIDGE_EVAL=1 and a logged-in Claude
// folder in JEVELLAN_BRIDGE_EVAL_CLAUDE_DIR. Each utterance runs headless (`claude -p`) with the bridge system prompt and the generated
// plugin against a test installation on the simulated runtime; the tool calls in the session's stream must match. Channels are not
// available headless, so the push arrives as a message starting [Jevellan push], which rule 6 of the prompt covers.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectShortIdsSchema, buildPlugin, pluginDist } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

const enabled = process.env.JEVELLAN_BRIDGE_EVAL === '1' && !!process.env.JEVELLAN_BRIDGE_EVAL_CLAUDE_DIR;
const PREFIX = 'mcp__plugin_jevellan_jevellan__';
let f: ProjectFixture | undefined; let folder = ''; let prompt = '';
type Call = { tool: string; input: Record<string, unknown> };

beforeAll(async () => {
  if (!enabled) return;
  f = await projectFixture({ control: true });
  const engine = f.app.projectWork; const hub = f.app.hub;
  // The state the utterances talk about: T31 running work, W12 the open deploy message, a review night item and a parser goal.
  const task = await engine.createTask('project', { schema: 'task-create-request-v1', clientRequestId: 'eval_task', title: 'Harden invoice parser tests', brief: 'Harden the parser tests.', type: 'feature', goalId: null, now: false, held: true, after: [], needs: [], fixed: {} });
  const decision = await engine.decisions.ask('project', { question: 'Deploy 1 landed thread(s) to production at a1b2c3d?', options: [{ label: 'Deploy a1b2c3d' }, { label: 'Not now' }] }, 'coordinator');
  const job = await engine.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'eval_suite', name: 'Full suite', goalId: null, enabled: true, run: { kind: 'command', command: 'true', timeoutMinutes: 5 }, gate: null });
  await engine.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'eval_suite_night', name: 'Full suite', goalId: null, order: 0, enabled: true, target: { kind: 'job', jobId: job.id } });
  await engine.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'eval_review', name: 'Review since last', goalId: null, order: 1, enabled: true, target: { kind: 'session', title: 'Review since last', brief: 'Review.', type: 'review' } });
  hub.put('owner-short-ids', 'project', ProjectShortIdsSchema, { schema: 'project-short-ids-v1', projectId: 'project', next: { T: 32, W: 13 }, ids: { [task.taskId]: 'T31', [decision]: 'W12' } }, 0);
  buildPlugin(f.homes);
  folder = mkdtempSync(join(tmpdir(), 'jevellan-bridge-eval-'));
  prompt = join(folder, 'system-prompt.md');
  writeFileSync(prompt, readFileSync(join(pluginDist(f.homes), 'jevellan', 'bridge', 'system-prompt.md'), 'utf8').replaceAll('{project}', f.project.name));
}, 120_000);
afterAll(async () => { await f?.close(); });

/** One headless bridge turn; the Jevellan tool calls it made, in order. */
function bridge(text: string): Call[] {
  const result = spawnSync('claude', ['-p', '--model', 'sonnet', '--effort', 'medium', '--plugin-dir', join(pluginDist(f!.homes), 'jevellan'), '--append-system-prompt-file', prompt,
    '--allowedTools', `${PREFIX}*`, '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', '--output-format', 'stream-json', '--verbose', '--max-turns', '6', text],
    { cwd: folder, encoding: 'utf8', timeout: 240_000, env: { ...process.env, CLAUDE_CONFIG_DIR: process.env.JEVELLAN_BRIDGE_EVAL_CLAUDE_DIR, JEVELLAN_HOME: f!.homes.root, JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: f!.project.name, JEVELLAN_ROLE: '' } });
  const calls: Call[] = [];
  for (const line of result.stdout.split('\n')) {
    let event: { type?: string; message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) if (block.type === 'tool_use' && block.name?.startsWith(PREFIX)) calls.push({ tool: block.name.slice(PREFIX.length), input: block.input ?? {} });
  }
  writeFileSync(join(folder, `${calls.length}-${text.slice(0, 20).replace(/\W+/gu, '_')}.jsonl`), result.stdout);
  return calls;
}
const writes = (calls: Call[]) => calls.filter(call => !['status', 'activity'].includes(call.tool) && !(call.tool === 'ask_coordinator' && call.input.mode === 'ask')
  && !(['work', 'goals', 'jobs', 'jev', 'config', 'login'].includes(call.tool) && ['list', 'show', 'inspect', 'history', 'night', 'deploy', 'health', 'rules', 'prompts', 'prompt_show', 'prompt_history', 'lessons', 'get', 'secrets', 'status'].includes(String(call.input.action))));
const some = (calls: Call[], match: (call: Call) => boolean) => calls.some(match);

const CASES: Array<[string, (calls: Call[]) => boolean]> = [
  ["what's going on?", calls => some(calls, call => call.tool === 'status')],
  ['what happened overnight?', calls => some(calls, call => call.tool === 'activity' && (call.input.kind ?? 'digest') === 'digest' && /night/iu.test(String(call.input.since ?? '')))],
  ['why is T31 on Opus?', calls => some(calls, call => call.tool === 'ask_coordinator' && call.input.mode === 'ask')],
  ['tell the coordinator to finish the parser work before anything new', calls => some(calls, call => call.tool === 'ask_coordinator' && call.input.mode === 'tell')],
  ['add a task to bump the PDF library, urgent', calls => some(calls, call => call.tool === 'work' && call.input.action === 'add' && (call.input.priority === 'urgent' || call.input.position === 'next'))],
  ['pause the review', calls => some(calls, call => call.tool === 'jobs' && call.input.action === 'pause' && /review/iu.test(String(call.input.job)))],
  ['move the night to half past midnight', calls => some(calls, call => call.tool === 'jobs' && call.input.action === 'schedule' && call.input.windowStart === '00:30')],
  ['take over T31', calls => some(calls, call => call.tool === 'thread' && call.input.action === 'open' && String(call.input.thread).toUpperCase() === 'T31')],
  ['deploy', calls => some(calls, call => call.tool === 'respond' && String(call.input.item).toUpperCase() === 'W12' && /^deploy/iu.test(String(call.input.answer)))],
  ['roll back', calls => some(calls, call => call.tool === 'jobs' && call.input.action === 'rollback' && call.input.confirm !== true) && !some(calls, call => call.tool === 'jobs' && call.input.action === 'rollback' && call.input.confirm === true)],
  ['switch deploys to nightly', calls => some(calls, call => call.tool === 'config' && call.input.action === 'set' && call.input.section === 'deploy' && call.input.key === 'mode' && call.input.value === 'nightly')],
  ['never put parser work below high effort', calls => some(calls, call => call.tool === 'jev' && call.input.action === 'rule_set')],
  ['[Jevellan push] W14 waiting on you: PR #88 by an external contributor: build passed, 2 tests failed. Options: merge, redo, close, later', calls => writes(calls).length === 0],
];

test.skipIf(!enabled).each(CASES)('bridge eval: %s', (utterance, check) => {
  const calls = bridge(utterance);
  expect({ utterance, calls, pass: check(calls) }).toMatchObject({ pass: true });
}, 300_000);
