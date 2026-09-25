import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Copied outside the checkout by the packed-install fixture. All application
// imports come from the installed version; only provider responses are scripted.
const applicationRoot = resolve(process.argv[2]), port = Number(process.argv[3]);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !process.send) throw new Error('Invalid installation fixture launch.');
const load = path => import(pathToFileURL(join(applicationRoot, path)).href);
const { z } = await load('node_modules/zod/index.js');
const { Homes, BridgeResultSchema } = await load('packages/core/dist/index.js');
const { JevRequestSchema, DecisionStateSchema } = await load('packages/decisions/dist/index.js');
const { FakeRuntime } = await load('packages/runtime-contract/dist/index.js');
const { createRuntime: createClaude } = await load('runtimes/claude/dist/index.js');
const { startDaemon } = await load('apps/daemon/dist/index.js');
const Control = z.strictObject({ schema: z.literal('installation-fixture-control-v1'), operation: z.literal('release') });
const Event = z.strictObject({ schema: z.literal('installation-fixture-event-v1'), state: z.enum(['ready', 'holding']) });
let release;
process.on('message', value => { Control.parse(value); release?.(); });
const send = state => process.send(Event.parse({ schema: 'installation-fixture-event-v1', state }));
const decisionFetch = async (_url, options) => {
  if (options.method === 'GET') return globalThis.Response.json({ models: [{ name: 'jev-1.13.0', description: 'Simulated installation judge.', release_date: '2026-09-25' }] });
  const body = JevRequestSchema.parse({ ...JSON.parse(options.body), schema: 'jev-request-v1' });
  const state = DecisionStateSchema.parse(JSON.parse(body.state));
  if (state.conversation.request !== 'Installation acceptance: change the value to two.') return new globalThis.Response(null, { status: 401 });
  return globalThis.Response.json({ model: 'jev-installation-simulated', usage: { input_tokens: 25, output_tokens: 15 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'keep_current' ? 0.9 : 0 }];
    if (question.type === 'score') {
      const last = question.criteria.length - 1;
      return [id, { type: 'score', score: last, probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === last ? 1 : 0])), legend: Object.fromEntries(question.criteria.map((description, index) => [String(index), description])), confidence: 1 }];
    }
    const choice = id === 'next_action' ? state.facts.stretchesThisWork ? 'done' : 'implement' : id === 'effort' ? 'low' : Object.keys(question.criteria)[0];
    if (!Object.hasOwn(question.criteria, choice)) throw new Error('The installation provider fixture cannot answer this question.');
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === choice ? 1 : 0])), confidence: 1 }];
  })) });
};
const daemon = await startDaemon(port, {
  homes: new Homes(process.env.JEVELLAN_HOME, process.env.HOME), decisionFetch,
  runtimes: context => {
    const runtime = createClaude(context), fake = new FakeRuntime();
    runtime.probe = async () => ({ auth: 'ready' });
    runtime.listModels = async () => [{ id: 'claude-fable-5-1', label: 'Simulated installation model', efforts: ['low', 'high'] }];
    runtime.startStretch = input => {
      fake.enqueue(async ({ input, emit, signal }) => {
        if (input.action !== 'implement') throw new Error('Unexpected installation fixture action.');
        emit({ type: 'text', delta: 'Simulated provider: the installation conversation is running.\n' });
        await new Promise((resolve, reject) => {
          const cancelled = () => { release = undefined; reject(new Error('Installation fixture cancelled.')); };
          release = () => { signal.removeEventListener('abort', cancelled); release = undefined; resolve(); };
          signal.addEventListener('abort', cancelled, { once: true });
          if (signal.aborted) cancelled(); else send('holding');
        });
        signal.throwIfAborted();
        emit({ type: 'tool-start', id: 'installation_write', name: 'Write file', input: { path: 'value.txt' } });
        writeFileSync(join(input.cwd, 'value.txt'), '2\n');
        emit({ type: 'tool-end', id: 'installation_write', ok: true, output: 'Changed the value to two.' });
        const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
          schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'Changed the value to two for installation acceptance.', evidence: [{ kind: 'file', ref: 'value.txt' }], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: ['value.txt'],
        } }) });
        if (!response.ok) throw new Error('Installation fixture handoff failed.');
        BridgeResultSchema.parse(await response.json());
        emit({ type: 'text', delta: 'The change is ready for independent verification.\n' });
        return { status: 'completed' };
      });
      return fake.startStretch(input);
    };
    return new Map([['claude', runtime]]);
  },
});
send('ready');
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await daemon.close(); process.disconnect?.(); };
process.on('SIGTERM', () => { void stop(); });
process.on('disconnect', () => { void stop(); });
