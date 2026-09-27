import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AccountSchema, BridgeResultSchema, BridgeToolsSchema, Homes, OverrideRecordSchema, ProjectSchema, SecretRedactor, parseConfiguration, readDocument, writeDocument } from '../packages/core/dist/index.js';
import { joinMember } from '../packages/mesh/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { createRuntime as createClaude } from '../runtimes/claude/dist/index.js';
import { createRuntime as createCodex } from '../runtimes/codex/dist/index.js';

// Browser fixtures exercise actual HTTP/vault/APM code with simulated providers.
const { Response } = globalThis;
const index = process.argv.indexOf('--port');
const port = index === -1 ? 19771 : Number(process.argv[index + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid test port.');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-browser-')));
mkdirSync(join(root, 'user'));
async function j11Step(input, emit, runtime) {
  const bridge = async payload => {
    const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', ...payload }) });
    assert(response.ok, 'J11 fixture bridge call failed.'); return response.json();
  };
  const call = async (name, args) => BridgeResultSchema.parse(await bridge({ operation: 'call', name, arguments: args })).result;
  const readGit = (...args) => execFileSync('git', args, { cwd: input.cwd, encoding: 'utf8' });
  let summary;
  if (input.action === 'reply' && input.memoryWrite) {
    await call('memory_write', { title: 'Vitest convention for mesh', content: 'This project uses Vitest with globals enabled.\nUse global test and expect.' });
    summary = 'Saved the Vitest convention in project memory.';
  } else {
    const memory = input.brief.split('# Memory\n\n')[1]?.split('\n\n# Your step')[0] ?? '';
    assert(memory.includes('Vitest convention for mesh') && memory.includes('globals enabled'), 'The J11 runtime did not receive the saved note in its Memory section.');
    emit({ type: 'text', delta: `J11 ${runtime} received project memory: Vitest convention for mesh; globals enabled.\n` });
    if (input.action === 'review') {
      assert.equal(input.permissions, 'read-only'); assert.equal(input.memoryWrite, false);
      const names = BridgeToolsSchema.parse(await bridge({ operation: 'list' })).tools.map(tool => tool.name);
      assert(names.includes('memory_propose')); assert(!names.includes('memory_write')); assert(!names.includes('memory_edit'));
      const head = readGit('rev-parse', 'HEAD'); const status = readGit('status', '--porcelain');
      await call('memory_propose', { title: 'Global test imports for mesh', content: 'Vitest tests can use global test and expect without importing them.', reason: 'Keep the shared test convention available to future work.' });
      assert.equal(readGit('rev-parse', 'HEAD'), head); assert.equal(readGit('status', '--porcelain'), status);
      summary = 'Proposed global test imports without changing the checkout.';
    } else summary = 'Recalled the shared Vitest convention for a new test.';
  }
  emit({ type: 'text', delta: summary });
  await call('jevellan_handoff', { schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary, evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] });
  return { status: 'completed' };
}
// Improver fixtures (J10/J12). Jev judgments, saved-case checks and the generative drafts are simulated:
// fixed answers and scripted drafts. Git, ownership, publication to the bare origin and Basic Memory are real.
const savedCaseRequests = new Set(JSON.parse(readFileSync(new URL('../packages/decisions/cases/decision-cases-v1.json', import.meta.url), 'utf8')).cases.map(entry => entry.state.conversation.request));
function improverAnswers(body, state) {
  const ids = Object.keys(body.questions);
  if (ids.every(id => /^(?:consistent_preference|pair_\d+|stale_\d+|rule_\d+)$/.test(id))) return Object.fromEntries(ids.map(id => {
    // Only the two seeded "Test conventions" notes are duplicates; related rule notes are distinct notes.
    const duplicate = (body.questions[id].instructions.toLowerCase().match(/test conventions/g) ?? []).length >= 2;
    return [id, { type: 'noul', noul: id.startsWith('pair_') ? duplicate ? 0.95 : 0.05 : id.startsWith('stale_') ? 0.1 : 0.9 }];
  }));
  if (state.schema !== 'decision-state-v1' || !savedCaseRequests.has(state.conversation?.request)) return null;
  return Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: 0 }];
    if (question.type === 'score') return [id, { type: 'score', score: 3, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 }, legend: { '0': 'not useful', '1': 'marginally useful', '2': 'useful', '3': 'essential' }, confidence: 1 }];
    const choice = Object.keys(question.criteria)[0];
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === choice ? 1 : 0])), confidence: 1 }];
  }));
}
async function improverDraft(input) {
  const has = name => existsSync(join(input.cwd, name)); const read = name => readFileSync(join(input.cwd, name), 'utf8');
  let type = 'suggestion'; let content;
  if (has('tasks.json')) {
    type = 'memory-patch'; const tasks = JSON.parse(read('tasks.json')); const files = new Map();
    const body = text => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    for (const [keep, remove] of tasks.merge) { files.set(keep, `${read(`memory/${keep}`).trimEnd()}\n\n${body(read(`memory/${remove}`))}\n`); files.set(remove, null); }
    for (const path of tasks.reconcile) {
      const [current, merged = ''] = read(`memory/${path}`).split(/\n## Merged from [^\n]*\n/);
      files.set(path, `${current.replace(/^status: unresolved\n/m, '').trimEnd()}\n\n## History\n\n${merged.trim()}\n`);
    }
    for (const link of tasks.fixLinks) files.set(link.note, (files.get(link.note) ?? read(`memory/${link.note}`)).replaceAll(`[[${link.target}]]`, '[[Test conventions]]'));
    content = { schema: 'memory-patch-draft-v1', summary: 'Simulated memory care draft.', files: [...files].map(([path, text]) => ({ path, content: text })) };
  } else if (has('instructions.md')) {
    content = { schema: 'context-draft-v1', title: 'Run the tests before pushing', reason: 'Three project notes state this working rule.', after: `${read('instructions.md').trimEnd()}\n\n## Working rules\n\n- Run the tests before every push.\n` };
  } else if (has('previous-draft.json')) {
    const previous = JSON.parse(read('previous-draft.json'));
    content = { ...previous, title: `${previous.title}, revised`, after: `${previous.before} ${has('instruction.txt') ? read('instruction.txt').trim() : 'Recomputed.'}` };
  } else if (has('corrections.json')) {
    const group = JSON.parse(read('corrections.json')); const settings = parseConfiguration(read('apm.yml'))['x-jevellan']; const evidenceOverrideIds = group.overrides.map(entry => entry.id);
    const model = group.key.field === 'model' ? settings.menu.find(entry => entry.id === group.key.to) : undefined;
    // Groups formed by other browser tests' corrections get a generic routing-profile draft.
    content = model
      ? { schema: 'routing-draft-v1', title: `Prefer ${model.label} for ${group.key.action} steps`, reason: `${group.overrides.length} consistent corrections chose ${model.label} for ${group.key.action} steps.`,
        field: { kind: 'menu-description', modelId: model.id }, before: model.description, after: `${model.description} Preferred for ${group.key.action} steps.`, evidenceOverrideIds }
      : { schema: 'routing-draft-v1', title: `Adjust routing for ${group.key.action ?? group.key.to ?? 'these'} steps`, reason: `${group.overrides.length} consistent corrections changed ${group.key.field}.`,
        field: { kind: 'routing-profile' }, before: settings.routingProfile, after: `${settings.routingProfile}\nFollow the recent ${group.key.field} corrections.`, evidenceOverrideIds };
  } else throw new Error('Unknown improver draft fixture.');
  const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
    schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'A simulated improver draft.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [], result: { type, content } } }) });
  if (!response.ok) throw new Error('Improver fixture handoff failed.'); return { status: 'completed' };
}
const decisionFetch = async (_url, init) => {
  if (init?.method === 'GET') return Response.json({ models: [{ name: 'jev-latest', description: 'Simulated browser fixture.', release_date: '2026-09-22' }] });
  const body = JSON.parse(init.body); const state = JSON.parse(body.state);
  const improver = improverAnswers(body, state);
  if (improver) return Response.json({ model: 'jev-browser-simulated', usage: { input_tokens: 25, output_tokens: 15 }, answers: improver });
  const composer = state.conversation.request === 'Exercise composer choices: explain the value.';
  if (!composer && state.conversation.request !== 'Exercise automatic decisions: change the value to two.') return new Response(null, { status: 401 });
  return Response.json({ model: 'jev-browser-simulated', usage: { input_tokens: 25, output_tokens: 15 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'keep_current' ? 0.9 : 0 }];
    if (question.type === 'score') return [id, { type: 'score', score: 3, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 }, legend: { '0': 'not useful', '1': 'marginally useful', '2': 'useful', '3': 'essential' }, confidence: 1 }];
    const choice = id === 'next_action' ? composer ? state.facts.stretchesThisWork < 2 ? 'reply' : 'done' : state.facts.stretchesThisWork ? 'done' : 'implement' : id === 'effort' ? 'medium' : Object.keys(question.criteria)[0];
    if (!Object.hasOwn(question.criteria, choice)) throw new Error('The browser fixture cannot answer this question.');
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === choice ? 1 : 0])), confidence: 1 }];
  })) });
};
const application = new Application({ homes: new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), port, decisionFetch, repositoryVisibility: async (path) => path === join(root, 'memory-project') ? 'PUBLIC' : 'UNKNOWN', runtimes: (context) => {
  const claude = createClaude(context); const codex = createCodex(context);
  for (const runtime of [claude, codex]) {
    const fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true;
    // Improver drafts get their own scripted queue, so they never take a turn meant for a concurrent conversation.
    const drafts = new FakeRuntime(); drafts.capabilities.readOnlyEnforced = true;
    runtime.probe = async () => ({ auth: 'ready', identity: { email: 'fixture@example.test' } });
    runtime.listModels = async () => [{ id: runtime.id === 'claude' ? 'claude-fable-5-1' : 'gpt-fixture', label: runtime.id === 'claude' ? 'Fable' : 'GPT fixture', efforts: ['low', 'high'] }];
    runtime.beginLogin = async (account) => {
      let state = 'pending'; let error; let completeAt;
      const complete = async () => { if (account.credential === 'shared') await context.saveSecret(account.id, `fixture-${randomUUID()}`); state = 'done'; };
      return { instructions: 'Paste the test authorization code.', url: 'https://claude.ai/oauth/authorize', get error() { return error; },
        poll: async () => { if (state === 'pending' && completeAt && Date.now() >= completeAt) await complete(); return state; },
        submitCode: async code => {
          if (code === 'fixture-rejected') { error = 'Claude reported a sign-in error. Start again to get a fresh sign-in link and code.'; state = 'failed'; }
          else if (code === 'fixture-delayed') completeAt = Date.now() + 4000;
          else await complete();
        },
        cancel: async () => { state = 'failed'; },
      };
    };
    runtime.startStretch = (input) => {
      if (input.inputCopy) { drafts.enqueue(({ input }) => improverDraft(input)); return drafts.startStretch(input); }
      if (input.cwd === join(root, 'j11-a')) { fake.enqueue(({ input, emit }) => j11Step(input, emit, runtime.id)); return fake.startStretch(input); }
      fake.enqueue(async ({ input, emit, signal }) => {
        emit({ type: 'text', delta: input.action === 'plan' ? 'I will preserve the request and verify the final change.\n' : 'Working on the requested change.\n' });
        emit({ type: 'tool-start', id: 'read_fixture', name: input.brief.includes('remaining work in my editor') ? `Read project · ${'long_tool_header_'.repeat(12)}` : 'Read project', input: { path: 'value.txt' } });
        await new Promise((resolve) => setTimeout(resolve, 350)); signal.throwIfAborted();
        emit({ type: 'tool-end', id: 'read_fixture', ok: true, output: 'The fixture starts with value 1.' });
        const value = input.brief.includes('value to three') ? '3' : '2';
        const evidenceFixture = input.brief.includes('Exercise evidence navigation');
        if (evidenceFixture && input.action === 'implement') {
          mkdirSync(join(input.cwd, 'src'), { recursive: true }); mkdirSync(join(input.cwd, 'docs'), { recursive: true });
          writeFileSync(join(input.cwd, 'src/example.ts'), `// Saved example\nexport const amount = ${input.stretch + 1};\nexport const label = '<b>plain text</b>';\n`);
          writeFileSync(join(input.cwd, 'docs/Guide with spaces.md'), '# Evidence guide\n\n- Read the source\n- Check the screenshot\n\n[Source line](../src/example.ts:2)\n\n![Recorded pixel](../screen.png)\n');
          writeFileSync(join(input.cwd, 'screen.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAjElEQVR42u3WoQ2AMBRF0b8AEyDwTIjGVrFRB6ojqe4GTQiG0pPcCY55L5Z1V6dAAAgQIECAAAECJECAAAECBOhnQPUu6gQIECBAgAABmg8ob2noAAECBAgQIECAHEVAgAABAgQIkJ4BHef1qQABAgQIECAzDwgQIECAAAESIECAAAECBAgQIAqAXtQA0FifkdQuyi4AAAAASUVORK5CYII=', 'base64'));
          emit({ type: 'text', delta: `\nOpen [the source](src/example.ts:2), [the value](value.txt:1), \`docs/Guide with spaces.md\`, or ${input.cwd}/screen.png.\n` });
        }
        if (input.action === 'implement') writeFileSync(join(input.cwd, 'value.txt'), `${value}\n`);
        if (input.action === 'implement' && input.brief.includes('Exercise external activity guards')) {
          const directory = join(application.homes.userHome, '.claude', 'projects', 'external-fixture'); mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, 'guard-fixture.jsonl'), JSON.stringify({ type: 'user', cwd: input.cwd, message: { content: 'Synthetic outside work.' } }) + '\n');
        }
        if (input.action === 'reply' && input.brief.includes('Exercise reviewed checkpoint recovery')) {
          writeFileSync(join(input.cwd, 'value.txt'), '2\n'); writeFileSync(join(input.cwd, 'review-note.txt'), 'Accept this new file after reviewing it.\n');
        }
        emit({ type: 'text', delta: input.action === 'implement' ? `The value is now ${value}, ready for Jevellan verification.` : 'The plan has three steps.' });
        const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
          schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: input.action === 'plan' ? 'A complete plan for the requested change.' : 'Changed the value and kept the requested scope.', evidence: [{ kind: 'file', ref: 'value.txt' }], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: input.action === 'implement' ? ['value.txt'] : [],
          ...(evidenceFixture ? { evidence: [{ kind: 'file', ref: 'docs/Guide with spaces.md' }, { kind: 'screenshot', ref: 'screen.png' }, { kind: 'command', ref: 'npm test', note: 'Command text is not executed by the viewer.' }], findings: [{ claim: 'The amount is declared on line two.', pointer: 'src/example.ts:2' }] } : {}),
          ...(input.action === 'plan' ? { result: { type: 'plan', content: '# The full fixture plan\n1. Change value.txt to two.\n2. Run the project test against the checkpoint.\n3. Publish the verified change.' } } : {}),
          ...(input.action === 'reply' && input.brief.includes('merge-draft') ? { result: { type: 'merge-draft', content: '# Shared project instructions\nPreserve the tests.\nRun the formatter.\n' } } : {}),
        } }) });
        if (!response.ok) throw new Error('Fixture handoff failed.');
        emit({ type: 'usage', inputTokens: 200, outputTokens: 100, costUsd: 0.01 }); return { status: 'completed' };
      });
      return fake.startStretch(input);
    };
  }
  return new Map([['claude', claude], ['codex', codex]]);
} });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin);
const projectPath = join(root, 'project'); git(root, 'clone', origin, projectPath); git(projectPath, 'config', 'user.name', 'Fixture'); git(projectPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(projectPath, 'value.txt'), '1\n'); writeFileSync(join(projectPath, 'AGENTS.md'), '# Browser fixture\nPreserve the request and its tests.\n');
git(projectPath, 'add', '-A'); git(projectPath, 'commit', '-m', 'Seed browser fixture'); git(projectPath, 'push', '-u', 'origin', 'main');
writeFileSync(join(projectPath, '.git/info/exclude'), '/CLAUDE.md\n'); symlinkSync('AGENTS.md', join(projectPath, 'CLAUDE.md'));
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'browser_fixture', name: 'Browser fixture', paths: { [application.device.deviceId]: projectPath }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const activityOrigin = join(root, 'activity-origin.git'); git(root, 'clone', '--bare', origin, activityOrigin);
const activityPath = join(root, 'activity-project'); git(root, 'clone', activityOrigin, activityPath); git(activityPath, 'config', 'user.name', 'Fixture'); git(activityPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(activityPath, '.git/info/exclude'), '/CLAUDE.md\n'); symlinkSync('AGENTS.md', join(activityPath, 'CLAUDE.md'));
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'activity_fixture', name: 'External activity fixture', paths: { [application.device.deviceId]: activityPath }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const automaticOrigin = join(root, 'automatic-origin.git'); git(root, 'clone', '--bare', origin, automaticOrigin);
const automaticPath = join(root, 'automatic-project'); git(root, 'clone', automaticOrigin, automaticPath); git(automaticPath, 'config', 'user.name', 'Fixture'); git(automaticPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(automaticPath, '.git/info/exclude'), '/CLAUDE.md\n'); symlinkSync('AGENTS.md', join(automaticPath, 'CLAUDE.md'));
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'automatic_fixture', name: 'Automatic fixture', paths: { [application.device.deviceId]: automaticPath }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const undoOrigin = join(root, 'undo-origin.git'); git(root, 'clone', '--bare', origin, undoOrigin);
const undoPath = join(root, 'undo-project'); git(root, 'clone', undoOrigin, undoPath); git(undoPath, 'config', 'user.name', 'Fixture'); git(undoPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(undoPath, '.git/info/exclude'), '/CLAUDE.md\n'); symlinkSync('AGENTS.md', join(undoPath, 'CLAUDE.md'));
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'undo_following', name: 'Undo across works', paths: { [application.device.deviceId]: undoPath }, branchPolicy: 'main', testCommand: 'test -f value.txt', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const contextOrigin = join(root, 'context-origin.git'); git(root, 'init', '--bare', '-b', 'main', contextOrigin);
const contextPath = join(root, 'context-project'); git(root, 'clone', contextOrigin, contextPath); git(contextPath, 'config', 'user.name', 'Fixture'); git(contextPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(contextPath, 'AGENTS.md'), '# Agent instructions\nPreserve the tests.\n'); writeFileSync(join(contextPath, 'CLAUDE.md'), '# Claude instructions\nRun the formatter.\n');
git(contextPath, 'add', '-A'); git(contextPath, 'commit', '-m', 'Seed context fixture'); git(contextPath, 'push', '-u', 'origin', 'main');
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'context_fixture', name: 'Context fixture', paths: { [application.device.deviceId]: contextPath }, branchPolicy: 'main', testCommand: 'test -f AGENTS.md', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const activityContextOrigin = join(root, 'activity-context-origin.git'); git(root, 'clone', '--bare', contextOrigin, activityContextOrigin);
const activityContextPath = join(root, 'activity-context-project'); git(root, 'clone', activityContextOrigin, activityContextPath); git(activityContextPath, 'config', 'user.name', 'Fixture'); git(activityContextPath, 'config', 'user.email', 'fixture@example.invalid');
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'activity_context', name: 'Outside context fixture', paths: { [application.device.deviceId]: activityContextPath }, branchPolicy: 'main', testCommand: 'test -f AGENTS.md', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const saveContextState = application.state.projects.context.bind(application.state.projects); let contextActivityInjected = false;
application.state.projects.context = async (...args) => {
  const result = await saveContextState(...args);
  if (args[0] === 'activity_context' && args[1].state === 'linked' && !contextActivityInjected) {
    contextActivityInjected = true;
    const directory = join(root, 'user', '.claude', 'projects', 'context-fixture'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'outside.jsonl'), JSON.stringify({ type: 'user', cwd: activityContextPath }) + '\n');
    writeFileSync(join(activityContextPath, 'outside.txt'), 'A synthetic outside contribution.\n');
  }
  return result;
};
const createOrigin = join(root, 'create-origin.git'); git(root, 'init', '--bare', '-b', 'main', createOrigin);
const createPath = join(root, 'create-project'); git(root, 'clone', createOrigin, createPath); git(createPath, 'config', 'user.name', 'Fixture'); git(createPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(createPath, 'value.txt'), '1\n'); git(createPath, 'add', '-A'); git(createPath, 'commit', '-m', 'Seed context creation fixture'); git(createPath, 'push', '-u', 'origin', 'main');
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'create_fixture', name: 'Empty context fixture', paths: { [application.device.deviceId]: createPath }, branchPolicy: 'main', testCommand: 'test -f AGENTS.md', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const adoptionOrigin = join(root, 'adoption-origin.git'); git(root, 'init', '--bare', '-b', 'main', adoptionOrigin);
const adoptionPath = join(root, 'adoption-project'); git(root, 'clone', adoptionOrigin, adoptionPath); git(adoptionPath, 'config', 'user.name', 'Fixture'); git(adoptionPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(adoptionPath, 'value.txt'), '1\n'); git(adoptionPath, 'add', '-A'); git(adoptionPath, 'commit', '-m', 'Seed checkpoint recovery fixture'); git(adoptionPath, 'push', '-u', 'origin', 'main');
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'adoption_fixture', name: 'Checkpoint recovery fixture', paths: { [application.device.deviceId]: adoptionPath }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const memoryOrigin = join(root, 'memory-origin.git'); git(root, 'init', '--bare', '-b', 'main', memoryOrigin);
const memoryPath = join(root, 'memory-project'); git(root, 'clone', memoryOrigin, memoryPath); git(memoryPath, 'config', 'user.name', 'Fixture'); git(memoryPath, 'config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(memoryPath, 'AGENTS.md'), '# Memory browser fixture\nPreserve the notes.\n');
const notePath = join(memoryPath, '.jevellan/memory/Guide.md'); mkdirSync(join(memoryPath, '.jevellan/memory'), { recursive: true });
writeFileSync(notePath, '---\ntitle: Public memory guide\n---\n# Public memory guide\n\nThis memorybrowserfixture note preserves **project knowledge**.\n\n- Read it before editing.\n- Keep the existing tests.\n');
git(memoryPath, 'add', '-A'); git(memoryPath, 'commit', '-m', 'Seed memory browser fixture'); git(memoryPath, 'push', '-u', 'origin', 'main');
writeFileSync(join(memoryPath, '.git/info/exclude'), '/CLAUDE.md\n'); symlinkSync('AGENTS.md', join(memoryPath, 'CLAUDE.md'));
const noteTime = new Date('2026-09-20T12:00:00.000Z'); utimesSync(notePath, noteTime, noteTime);
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'memory_fixture', name: 'Public memory fixture', paths: { [application.device.deviceId]: memoryPath }, branchPolicy: 'main', testCommand: 'test -f AGENTS.md', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
for (const runtime of ['claude', 'codex']) {
  const id = `acc_rigging_${runtime}`;
  application.hub.put('accounts', id, AccountSchema, { schema: 'account-v1', id, runtime, label: runtime === 'claude' ? 'Rigging local fixture' : 'Rigging Codex fixture', kind: 'subscription', enabled: false, ceilingPct: 90, credential: 'per-device' }, 0);
  application.homes.account(runtime, id);
}
const riggingHome = application.homes.account('claude', 'acc_rigging_claude'); mkdirSync(join(riggingHome, 'skills/browser-local/assets'), { recursive: true });
writeFileSync(join(riggingHome, 'skills/browser-local/SKILL.md'), '# Loose browser instructions\nPreserve the bundled example.\n'); writeFileSync(join(riggingHome, 'skills/browser-local/assets/example.txt'), 'Bundled fixture stays unchanged.\n');
mkdirSync(join(riggingHome, 'skills/browser-promote/assets'), { recursive: true }); writeFileSync(join(riggingHome, 'skills/browser-promote/SKILL.md'), '# Promote browser instructions\nUse the bundled example.\n'); writeFileSync(join(riggingHome, 'skills/browser-promote/assets/example.txt'), 'Captured fixture stays unchanged.\n');
mkdirSync(join(riggingHome, 'rules'), { recursive: true }); writeFileSync(join(riggingHome, 'rules/retry.md'), 'Recover this completed move.\n');
const retryItem = application.riggingDisk.list([{ id: 'acc_rigging_claude', runtime: 'claude' }]).items.find((item) => item.name === 'retry.md');
await application.riggingDisk.transition('claude', 'acc_rigging_claude', retryItem.id, { schema: 'rigging-disk-transition-v1', requestId: 'browser_pending', fingerprint: retryItem.fingerprint, action: 'park' });
const retryPath = application.homes.at('rigging/operations/claude/acc_rigging_claude/browser_pending.json'); const retryRecord = JSON.parse(readFileSync(retryPath, 'utf8')); retryRecord.status = 'prepared'; writeFileSync(retryPath, JSON.stringify(retryRecord));
const packageArchive = application.homes.ensure('rigging/parked/claude/acc_rigging_claude', 'b'.repeat(64), 'skills/browser-package'); writeFileSync(join(packageArchive, 'SKILL.md'), '# Parked package instructions\nRead-only package snapshot.\n');
writeFileSync(join(application.homes.account('codex', 'acc_rigging_codex'), 'config.toml'), 'model_reasoning_effort = "high"\n[mcp_servers.fixture_tools]\ncommand = "fixture-tools"\nargs = []\n');
await application.auth.setup({ schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' });
const server = createDaemon({ application });
let member; let memberServer; let memberHeartbeat; let improverControl;
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  globalThis.clearInterval(memberHeartbeat);
  improverControl?.close();
  await member?.close();
  if (memberServer) await new Promise(resolve => { memberServer.close(resolve); memberServer.closeAllConnections(); });
  await application.close();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const memberHomes = new Homes(join(root, 'member-home'), join(root, 'user'));
const FixtureAuthSchema = z.strictObject({ schema: z.literal('fixture-auth-v1'), fixture_login: z.literal(true) });
await joinMember(memberHomes, { schema: 'member-join-input-v1', hubUrl: `http://127.0.0.1:${port}`, code: application.mesh.invite().code, device: { name: 'Browser member', url: `http://127.0.0.1:${port + 100}`, os: 'linux', version: '0.1.0' } }, { redactor: new SecretRedactor() });
member = new Application({ homes: memberHomes, port: port + 100, timers: false, decisionFetch, runtimes: context => {
  const runtime = createCodex(context);
  const fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true;
  runtime.probe = async resolved => ({ auth: existsSync(join(resolved.home, 'auth.json')) && readDocument(join(resolved.home, 'auth.json'), FixtureAuthSchema).fixture_login ? 'ready' : 'missing', identity: { email: 'remote-fixture@example.test' } });
  runtime.listModels = async () => [{ id: 'gpt-fixture', label: 'GPT fixture', efforts: ['low', 'high'] }];
  runtime.beginLogin = async (_account, home) => {
    let state = 'pending';
    return { instructions: 'Paste the simulated callback address for this device.', url: 'https://example.test/authorize', poll: async () => state,
      submitCode: async () => { writeDocument(join(home, 'auth.json'), FixtureAuthSchema, { schema: 'fixture-auth-v1', fixture_login: true }); state = 'done'; }, cancel: async () => { state = 'failed'; } };
  };
  runtime.startStretch = input => {
    if (input.cwd === join(root, 'j11-b')) { fake.enqueue(({ input, emit }) => j11Step(input, emit, runtime.id)); return fake.startStretch(input); }
    const handoff = async (input, partial = false) => {
      const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: { schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: partial ? 'partial' : 'done', summary: partial ? 'Device B stopped for the correction from device A.' : 'Device B completed the requested reply.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] } }) });
      if (!response.ok) throw new Error('Member fixture handoff failed.'); return { status: 'completed' };
    };
    if (input.brief.includes('J8: run on device B')) fake.enqueue(async ({ emit, signal }) => {
      emit({ type: 'text', delta: 'Working on device B while you watch from device A.\n' });
      let n = 0; const timer = globalThis.setInterval(() => emit({ type: 'text', delta: `Device B progress ${++n}.\n` }), 750);
      try { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); return { status: 'interrupted' }; }
      finally { globalThis.clearInterval(timer); }
    }, async ({ input }) => handoff(input, true));
    else fake.enqueue(async ({ input, emit }) => { emit({ type: 'text', delta: 'A simulated reply from device B.\n' }); return handoff(input); });
    return fake.startStretch(input);
  };
  return new Map([['codex', runtime]]);
} });
await member.conversations.ready;
memberServer = createDaemon({ application: member }); await new Promise(resolve => memberServer.listen(port + 100, '127.0.0.1', resolve));
const reportMember = () => member.member.heartbeat({ schema: 'heartbeat-v1', deviceId: member.device.deviceId, at: new Date().toISOString(), version: '0.1.0', runningConversations: ['fixture_remote_work'], projects: [], externalSessions: [{ runtime: 'codex', cwd: '/fixture/remote-project', lastActivityAt: new Date().toISOString(), source: 'simulated' }], load: { cpuPct: 0, memFreeMb: 1024 } });
await reportMember(); memberHeartbeat = globalThis.setInterval(() => { void reportMember().catch(() => {}); }, 30_000);
application.mesh.join({ schema: 'join-device-v1', code: application.mesh.invite().code, requestId: 'offline_browser_fixture', device: { id: 'offline_browser_fixture', name: 'Offline fixture', url: 'http://127.0.0.1:1', os: 'linux', version: '0.1.0' } }, 'fixture');
const meshOrigin = join(root, 'mesh-origin.git'); git(root, 'clone', '--bare', origin, meshOrigin);
const meshA = join(root, 'mesh-a'); const meshB = join(root, 'mesh-b');
for (const path of [meshA, meshB]) { git(root, 'clone', meshOrigin, path); git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid'); }
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'mesh_fixture', name: 'Mesh journey fixture', paths: { [application.device.deviceId]: meshA, [member.device.deviceId]: meshB }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const j11Origin = join(root, 'j11-origin.git'); git(root, 'clone', '--bare', origin, j11Origin);
const j11A = join(root, 'j11-a'); const j11B = join(root, 'j11-b'); git(root, 'clone', j11Origin, j11A);
git(j11A, 'config', 'user.name', 'Fixture'); git(j11A, 'config', 'user.email', 'fixture@example.invalid');
mkdirSync(join(j11A, '.jevellan/memory'), { recursive: true }); writeFileSync(join(j11A, '.jevellan/memory/Existing.md'), '---\ntitle: Existing convention\n---\nPreserve existing project behavior.\n');
git(j11A, 'add', '-A'); git(j11A, 'commit', '-m', 'Seed existing memory'); git(j11A, 'push'); git(root, 'clone', j11Origin, j11B);
git(j11B, 'config', 'user.name', 'Fixture'); git(j11B, 'config', 'user.email', 'fixture@example.invalid');
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'j11_fixture', name: 'J11 memory journey', paths: { [application.device.deviceId]: j11A, [member.device.deviceId]: j11B }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 1', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
const j11ContextOrigin = join(root, 'j11-context-origin.git'); git(root, 'clone', '--bare', contextOrigin, j11ContextOrigin);
const j11Context = join(root, 'j11-context'); git(root, 'clone', j11ContextOrigin, j11Context); git(j11Context, 'config', 'user.name', 'Fixture'); git(j11Context, 'config', 'user.email', 'fixture@example.invalid');
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'j11_context', name: 'J11 context journey', paths: { [application.device.deviceId]: j11Context }, branchPolicy: 'main', testCommand: 'test -f AGENTS.md', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
// Improver journeys (J10/J12): a dedicated sandbox with a bare origin, and memory care limited to it.
const improverOrigin = join(root, 'improver-origin.git'); git(root, 'init', '--bare', '-b', 'main', improverOrigin);
const improverPath = join(root, 'improver-sandbox'); git(root, 'clone', improverOrigin, improverPath); git(improverPath, 'config', 'user.name', 'Fixture'); git(improverPath, 'config', 'user.email', 'fixture@example.invalid');
const improverMemory = join(improverPath, '.jevellan/memory'); mkdirSync(improverMemory, { recursive: true });
writeFileSync(join(improverPath, 'AGENTS.md'), '# Improver sandbox\n\nRun npm test.\n');
writeFileSync(join(improverMemory, 'old-caching-idea.md'), '---\ntitle: Old caching idea\n---\nWe once considered caching builds in S3.\n');
const old = new Date(Date.now() - 200 * 86400_000).toISOString();
git(improverPath, 'add', '-A'); execFileSync('git', ['commit', '-m', 'Seed improver sandbox'], { cwd: improverPath, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
writeFileSync(join(improverMemory, 'test-conventions.md'), '---\ntitle: Test conventions\n---\nUse Vitest with globals enabled.\n');
writeFileSync(join(improverMemory, 'test-conventions-2.md'), '---\ntitle: Test Conventions\n---\nTests run with Vitest and globals are on.\n');
writeFileSync(join(improverMemory, 'deploy.md'), '---\ntitle: Deploy notes\nstatus: unresolved\n---\nDeploy with npm run deploy. See [[Missing guide]].\n\n## Merged from laptop on 2026-09-20\n\nDeploy by hand from the release branch.\n');
for (const [name, title] of [['push-tests.md', 'Run tests before pushing'], ['ci-green.md', 'Always run the tests before a push'], ['pre-push.md', 'Tests must pass before pushing']]) writeFileSync(join(improverMemory, name), `---\ntitle: ${title}\n---\n${title}. Never push with failing tests.\n`);
git(improverPath, 'add', '-A'); git(improverPath, 'commit', '-m', 'Improver memory notes'); git(improverPath, 'push', '-u', 'origin', 'main');
await application.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'improver_sandbox', name: 'Improver sandbox', paths: { [application.device.deviceId]: improverPath }, branchPolicy: 'main', testCommand: 'test -f AGENTS.md', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
{
  const current = application.hub.configuration.current(); const settings = current.configuration['x-jevellan'].improver;
  settings.schedule.enabled = false;
  for (const row of await application.state.projects.list()) if (row.project.id !== 'improver_sandbox') settings.memory.projects[row.project.id] = false;
  application.hub.configuration.put(current.configuration, current.revision, { deviceId: application.device.deviceId, source: 'install' });
}
const correction = (group, n, action, from, to) => {
  const id = `improver_${group}_${n}`;
  application.hub.put('overrides', id, OverrideRecordSchema, { schema: 'override-v1', id, request: { schema: 'correct-step-v1', clientRequestId: `request_${id}`, generation: 0, stretch: 1, mode: 'noted', choices: { modelId: to } },
    conversationId: 'improver_fixture_conversation', projectId: 'improver_sandbox', workId: `work_${id}`, decisionId: `decision_${id}`, at: new Date().toISOString(), action, context: `A ${action} step in the improver fixture.`, changes: [{ field: 'model', from, to }] }, 0);
};
for (const n of [1, 2, 3]) { correction('implement', n, 'implement', 'claude-fable', 'codex-gpt'); correction('review', n, 'review', 'claude-fable', 'claude-opus'); }
// Fixture control for J10's later "seed a third group" step. It listens on this server's own offset only.
improverControl = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/improver/third-group') {
    for (const n of [1, 2, 3]) if (!application.hub.get('overrides', `improver_plan_${n}`, OverrideRecordSchema)) correction('plan', n, 'plan', 'claude-fable', 'claude-sonnet');
    response.writeHead(204).end(); return;
  }
  response.writeHead(404).end();
});
await new Promise(resolve => improverControl.listen(port + 200, '127.0.0.1', resolve));
