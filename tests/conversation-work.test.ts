import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionRecordSchema, Homes, HandoffSchema, SecretRedactor, StretchSchema, UndoAppliedSchema, VerificationSchema, type Action } from '../packages/core/dist/index.js';
import { ConversationLedger, ConversationWork, MemoryQueue, bindComposerChoices, buildBrief, composerOverrides, planComposerBindings, queueMemory, saveComposerChoice } from '../packages/conversations/dist/index.js';

let root: string; let homes: Homes; let ledger: ConversationLedger; let store: ConversationWork;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-work-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  ledger = new ConversationLedger(homes, 'conversation'); store = new ConversationWork(ledger, 3);
  store.create({ title: 'Fixture', projectId: 'project', ownerDeviceId: 'device' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function start(action: Action = 'plan') {
  const view = store.load(); const n = view.conversation.stretchCount + 1;
  store.start(StretchSchema.parse({ schema: 'stretch-v2', n, workId: view.conversation.work!.id, action, modelId: 'model', runtime: 'codex', model: 'model', effortRequested: 'high', effortEffective: 'high', accountId: 'account', deviceId: 'device', decisionId: `decision_${n}`, startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' }, gitBefore: 'base' }), view.conversation.generation);
  return n;
}
function finish(action: Action = 'plan', summary = 'Done', extra = {}) {
  const n = store.load().conversation.stretchCount;
  ledger.acceptHandoff(HandoffSchema.parse({ schema: 'handoff-v2', stretch: n, action, status: 'done', summary, evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: 'implement', changedFiles: [], ...extra }));
  return store.finish(n, { status: 'completed', usage: { inputTokens: 10, outputTokens: 5, costSource: 'reported', costUsd: 0.1 }, gitAfter: `commit_${n}` }, true);
}
test('Garrison continuity regression: plan, approval, implementation, block and reply retain one exact work', () => {
  const request = '  Fix negative numbers.\nKeep mobile usable and all evidence.  ';
  store.message(request, 'first'); store.baseCommit('original-head'); const workId = store.load().conversation.work!.id;
  start(); const plan = ledger.putBlob('# Full plan\n1. Preserve constraints.\n2. Add tests.');
  finish('plan', 'Plan attached', { result: { type: 'plan', ref: plan.ref }, findings: [{ claim: 'constraint: preserve negative numbers', pointer: 'src/sum.ts:1' }] });
  store.pause('Read the plan');
  const generation = store.load().conversation.generation; store.approvePlan(plan.ref, generation);
  store.message('Go ahead.', 'approval'); start('implement'); finish('implement', 'Implemented; still needs final proof.');
  store.pause('Need another detail', 'blocked'); store.message('Keep the existing public signature.', 'continuation');
  const view = new ConversationWork(new ConversationLedger(homes, 'conversation')).recover();
  expect(view.conversation.work).toMatchObject({ id: workId, request, baseCommit: 'original-head', latestPlanRef: plan.ref, approvedPlanRef: plan.ref, counters: { stretches: 2 }, constraints: ['constraint: preserve negative numbers'] });
  expect(view.summary.objective).toBe(request); expect(view.messages.map((message) => message.text)).toEqual([request, 'Go ahead.', 'Keep the existing public signature.']);
  expect(() => store.baseCommit('another-head')).toThrow('cannot be replaced');
});
test.each(['done', 'cancelled', 'closed-by-you'] as const)('new request after %s starts fresh without old blockers, constraints or counters', (closedAs) => {
  store.message('Old request', 'old'); start(); finish('plan', 'Old state', { blockers: ['old blocker'], findings: [{ claim: 'constraint: old limit', pointer: 'ledger/2' }] });
  store.close(closedAs); store.message('New request', 'new'); const view = store.load();
  expect(view.closedWorks).toHaveLength(1); expect(view.closedWorks[0]?.closedAs).toBe(closedAs);
  expect(view.conversation.work).toMatchObject({ request: 'New request', constraints: [], messageEventIds: [], counters: { stretches: 0, reviews: 0, noProgress: 0 } });
  expect(view.conversation.work?.baseCommit).toBeUndefined(); expect(view.summary).toMatchObject({ objective: 'New request', state: '', decisions: [], nextWork: '' });
});
test('a retry after a lost message response bumps generation only once and never launches work', () => {
  const first = store.message('Exact request', 'request');
  const replayed = new ConversationWork(new ConversationLedger(homes, 'conversation')).message('Exact request', 'request');
  expect(replayed.repeated).toBe(true); expect(replayed.eventId).toBe(first.eventId); expect(replayed.view.conversation.generation).toBe(1);
  expect(replayed.view.stretches).toEqual([]); expect(() => store.message('Changed body', 'request')).toThrow('different content');
});
test('a durable decision consumes composer choices even if their receipts fail, and recovery never consumes later choices', () => {
  store.message('Explain the value.', 'request');
  for (const [field, value] of [['action', 'reply'], ['model', 'model'], ['effort', 'high']] as const) saveComposerChoice(store, { schema: 'composer-choice-v1', clientRequestId: `choose_${field}`, generation: store.load().conversation.generation, field, value, mode: 'once' });
  const before = store.load().conversation;
  const decision = DecisionRecordSchema.parse({ schema: 'decision-v2', id: 'decision_composer', conversationId: 'conversation', workId: before.work!.id, n: 1, generation: before.generation, trigger: 'user-message', at: new Date().toISOString(), latencyMs: 0,
    action: { chosen: 'reply', source: 'override', allowed: ['reply'] }, model: { chosen: 'model', source: 'override', eligible: [{ modelId: 'model' }], excluded: [] }, effort: { requested: 'high', effective: 'high', source: 'override' },
    context: { project: 'Fixture', action: 'reply', changeSize: 'small', riskyAreasTouched: [] }, correctionsShown: [], notices: [] });
  decision.composer = planComposerBindings(store, decision); ledger.append({ type: 'decision', data: decision });
  const append = ledger.append.bind(ledger); const failing = vi.spyOn(ledger, 'append').mockImplementation((input) => { if (input.type === 'override') throw new Error('simulated receipt failure'); return append(input); });
  expect(() => bindComposerChoices(store, decision)).toThrow('receipt failure'); failing.mockRestore();
  expect(store.load().conversation.once).toEqual({}); expect(composerOverrides(store).every((record) => record.status === 'applied' && record.decisionId === decision.id)).toBe(true);
  const reopened = new ConversationWork(new ConversationLedger(homes, 'conversation')); const recovered = reopened.recover();
  expect(recovered.conversation.generation).toBe(before.generation); expect(recovered.stretches).toEqual([]); expect(recovered.conversation.once).toEqual({});
  bindComposerChoices(reopened, decision); const receiptCount = reopened.ledger.events().filter((event) => event.type === 'override').length; expect(receiptCount).toBe(6);
  saveComposerChoice(reopened, { schema: 'composer-choice-v1', clientRequestId: 'later_effort', generation: recovered.conversation.generation, field: 'effort', value: 'low', mode: 'once' });
  reopened.ledger.append({ type: 'decision', data: { ...decision, outcome: { stretch: 1, status: 'failed' } } }); bindComposerChoices(reopened, decision);
  expect(reopened.load().conversation.once).toEqual({ effort: 'low' }); expect(composerOverrides(reopened).at(-1)!.status).toBe('pending');
  expect(reopened.ledger.events().filter((event) => event.type === 'override')).toHaveLength(receiptCount + 1);
});
test('guard reply grants one allowance, including recovery after a lost allowance receipt', () => {
  store.message('Request', 'request'); store.pause('Step limit', 'waiting-for-you', 'steps');
  const original = ledger.append.bind(ledger); let once = true;
  vi.spyOn(ledger, 'append').mockImplementation((input) => { if (input.type === 'allowance' && once) { once = false; throw new Error('simulated failure after message durability'); } return original(input); });
  expect(() => store.message('Continue', 'resume')).toThrow('after message');
  const reopened = new ConversationWork(new ConversationLedger(homes, 'conversation'), 3); reopened.recover(); reopened.message('Continue', 'resume');
  const work = reopened.load().conversation.work!;
  expect(work.allowance.stretches).toBe(6); expect(work.allowance.grants).toHaveLength(1); expect(work.counters.stretches).toBe(0);
  expect(ledger.events().filter((event) => event.type === 'allowance')).toHaveLength(1);
});
test('notes and corrections both persist verbatim; only corrections request interruption', () => {
  store.message('Request', 'request'); start();
  expect(store.message('An extra reference.', 'note', 'note').correction).toBe(false);
  expect(store.message('Change direction.', 'steering').correction).toBe(true);
  expect(store.load().conversation.state).toBe('running'); expect(store.load().conversation.generation).toBe(3);
  expect(store.load().conversation.work?.messageEventIds).toHaveLength(2);
  expect(() => store.close('cancelled')).toThrow('finish first');
});
test('pins and messages invalidate decisions, and an existing active stretch cannot launch twice', () => {
  store.message('Request', 'request'); const view = store.load(); store.pins({ effort: 'max' });
  const n = start(); const running = store.load().stretches[0]!;
  expect(() => store.start(running, view.conversation.generation)).toThrow('stale');
  expect(() => store.start({ ...running, n: n + 1 }, store.load().conversation.generation)).toThrow('Cannot start');
  expect(store.load().stretches).toHaveLength(1);
});
test('durable native identity and partial output survive lost projections without replay causing work', () => {
  store.message('Request', 'request'); const n = start(); store.native(n, { pid: 123456, pgid: 123456, startIdentity: 'fixture' });
  store.runtimeEvent('text', { delta: 'Partial output before crash' }, n);
  unlinkSync(join(ledger.dir, 'conversation.json')); unlinkSync(join(ledger.dir, 'summary.json'));
  const before = ledger.events(); const recovered = new ConversationWork(new ConversationLedger(homes, 'conversation')).recover();
  expect(recovered.stretches[0]?.native?.startIdentity).toBe('fixture'); expect(recovered.conversation.state).toBe('running');
  expect(ledger.events()).toEqual(before); expect(ledger.search('Partial output')).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(ledger.dir, 'conversation.json'), 'utf8')).work.request).toBe('Request');
  // The owner restart service must terminate that native process before recording interruption;
  // replay itself never assumes it is dead and never clears ownership.
});
test('message idempotence compares redacted content so credentials never persist in request snapshots', () => {
  const secret = ['fixture', 'private', 'request'].join('-'); const redactor = new SecretRedactor(); redactor.add(secret);
  const privateLedger = new ConversationLedger(homes, 'private', { redactor }); const privateStore = new ConversationWork(privateLedger);
  privateStore.create({ title: 'Fixture', projectId: 'project', ownerDeviceId: 'device' });
  privateStore.message(`Never expose ${secret}`, 'message'); expect(privateStore.message(`Never expose ${secret}`, 'message').repeated).toBe(true);
  expect(privateStore.load().conversation.work?.request).toBe('Never expose [redacted]');
  expect(readFileSync(join(privateLedger.dir, 'conversation.json'), 'utf8')).not.toContain(secret);
});
test('a finding recorded before handoff becomes a durable constraint and counts as progress', () => {
  store.message('Request', 'request'); store.baseCommit('base'); const n = start('implement');
  store.runtimeEvent('finding', { claim: 'constraint: maintain the public signature', pointer: 'src/index.ts:1' }, n);
  ledger.acceptHandoff(HandoffSchema.parse({ schema: 'handoff-v2', stretch: n, action: 'implement', status: 'partial', summary: 'The constraint needs a different implementation.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: 'implement', changedFiles: [] }));
  const view = store.finish(n, { status: 'completed', usage: { inputTokens: 1, outputTokens: 1, costSource: 'unknown' }, gitAfter: 'base' }, false);
  expect(view.conversation.work?.constraints).toEqual(['constraint: maintain the public signature']);
  expect(view.conversation.work?.counters.noProgress).toBe(0);
});

function undo(fromStretch: number, id = `undo_${fromStretch}`) {
  const view = store.load(); const work = view.conversation.work ?? view.closedWorks.at(-1)!;
  return UndoAppliedSchema.parse({ schema: 'undo-applied-v1', id, workId: work.id, fromStretch, throughStretch: view.stretches.filter((step) => step.workId === work.id && step.status !== 'undone').at(-1)!.n, generation: view.conversation.generation, mode: 'unchanged' });
}
function verification(passed: boolean) {
  const work = store.load().conversation.work!;
  ledger.append({ type: 'verification', data: VerificationSchema.parse({ schema: 'verification-v1', id: `verification_${ledger.events().length}`, workId: work.id, at: new Date().toISOString(), trigger: 'done-gate', command: 'fixture-test', exitCode: passed ? 0 : 1, passed, outputRef: ledger.putBlob('Fixture output').ref, commit: `commit_${store.load().conversation.stretchCount}`, treeClean: true }) });
}
test('undo removes later semantic state and queued memory, while preserving the request, messages, plan and allowance', () => {
  store.message('Keep the exact objective.\nPreserve its spacing.', 'request'); store.baseCommit('original-head');
  start('plan'); const plan = ledger.putBlob('# The retained full plan'); finish('plan', 'Retained plan', { result: { type: 'plan', ref: plan.ref }, findings: [{ claim: 'constraint: original requirement', pointer: 'AGENTS.md:1' }] });
  store.approvePlan(plan.ref, store.load().conversation.generation);
  start('implement'); queueMemory(store, 2, { title: 'Discarded learning', content: 'Do not recall this.', reason: 'Fixture proposal' });
  finish('implement', 'Discarded implementation', { findings: [{ claim: 'constraint: discarded constraint', pointer: 'src/old.ts:1' }, { claim: 'decision: discarded decision', pointer: 'src/old.ts:2' }] });
  start('review'); store.message('Preserve my note verbatim.', 'note', 'note'); finish('review', 'Discarded review', { blockers: ['Discarded blocker'], testsRun: { command: 'fixture-test', passed: false, summary: 'Failure' } });
  verification(false); store.pause('Guard stop', 'waiting-for-you', 'steps'); store.message('Continue this original work.', 'resume');
  const before = store.load(); const handoffs = ledger.handoffs(); const applied = undo(2); const view = store.undo(applied);
  expect(view.conversation.work).toMatchObject({ id: before.conversation.work!.id, request: before.conversation.work!.request, baseCommit: 'original-head', messageEventIds: before.conversation.work!.messageEventIds, allowance: before.conversation.work!.allowance, latestPlanRef: plan.ref, approvedPlanRef: plan.ref, constraints: ['constraint: original requirement'], counters: { stretches: 1, reviews: 0, noProgress: 0, testFailures: 0, costUsd: 0.1, unknownCostStretches: 0 } });
  expect(view.conversation.generation).toBe(before.conversation.generation + 1); expect(view.conversation.stretchCount).toBe(3);
  expect(view.stretches.map((step) => step.status)).toEqual(['completed', 'undone', 'undone']); expect(view.summary).toMatchObject({ state: 'Retained plan', decisions: [], updatedAtStretch: 1 });
  expect(new MemoryQueue(store).pending(before.conversation.work!.id)).toEqual([]); expect(ledger.handoffs()).toEqual(handoffs);
  const brief = buildBrief(view, ledger, { action: 'implement', project: { name: 'Fixture', branchPolicy: 'main' }, cwd: root, memoryWrite: true }).text;
  expect(brief).toContain('# The retained full plan'); expect(brief).toContain('(approved)'); expect(brief).toContain('Preserve my note verbatim.'); expect(brief).not.toMatch(/Discarded|discarded/);
  expect(new ConversationWork(new ConversationLedger(homes, 'conversation')).recover()).toEqual(view);
});

test('undo on the last closed work reopens it, removes an undone plan and keeps monotonic step numbers for redo', () => {
  store.message('Original work', 'request'); store.baseCommit('base'); start('plan'); const plan = ledger.putBlob('# Undone plan'); finish('plan', 'Plan', { result: { type: 'plan', ref: plan.ref } });
  store.approvePlan(plan.ref, store.load().conversation.generation); start('implement'); finish('implement'); store.close('done'); const original = store.load().closedWorks[0]!;
  const view = store.undo(undo(1)); expect(view.closedWorks).toEqual([]); expect(view.conversation.work).toMatchObject({ id: original.id, request: original.request, baseCommit: original.baseCommit, counters: { stretches: 0, costUsd: 0 } });
  expect(view.conversation.work?.latestPlanRef).toBeUndefined(); expect(view.conversation.work?.approvedPlanRef).toBeUndefined(); expect(view.conversation.work?.closedAs).toBeUndefined(); expect(view.conversation.current).toBeUndefined();
  expect(view.summary).toMatchObject({ objective: original.request, state: '', decisions: [], nextWork: '', updatedAtStretch: 0 });
  expect(JSON.parse(readFileSync(join(ledger.dir, 'work', `${original.id}.json`), 'utf8')).closedAs).toBeUndefined();
  expect(start('reply')).toBe(3); finish('reply', 'Redone answer'); expect(store.load().conversation.work?.counters.stretches).toBe(1); expect(store.load().summary.state).toBe('Redone answer');
});

test('undo survives a lost projection and repeated requests cannot invalidate newer work or rewrite the receipt', () => {
  store.message('Request', 'request'); start(); finish(); const operation = undo(1); const generation = operation.generation;
  const original = ledger.writeProjection.bind(ledger); let fail = true;
  vi.spyOn(ledger, 'writeProjection').mockImplementation((...args) => { if (fail) { fail = false; throw new Error('Lost projection'); } return original(...args); });
  expect(() => store.undo(operation)).toThrow('Lost projection');
  const recovered = new ConversationWork(new ConversationLedger(homes, 'conversation')); expect(recovered.recover().conversation.generation).toBe(generation + 1);
  expect(recovered.undo(operation).conversation.generation).toBe(generation + 1); expect(ledger.events().filter((event) => event.type === 'undo')).toHaveLength(1);
  expect(() => recovered.undo({ ...operation, mode: 'external' })).toThrow('different operation');
  recovered.message('Additional user direction.', 'direction'); expect(recovered.undo(operation).conversation.generation).toBe(generation + 2);
});

test.each([false, true])('undo of closed work preserves the newer request and notes, with newer steps: %s', (withSteps) => {
  store.message('Original request, verbatim.', 'original'); store.baseCommit('base'); const original = store.load().conversation.work!;
  start('implement'); finish('implement'); store.close('done');
  store.message('Newer request.\nKeep its exact wording.', 'newer');
  if (withSteps) { start('plan'); store.message('A later note must survive too.', 'later_note', 'note'); finish('plan', 'A plan that will be undone.', { findings: [{ claim: 'constraint: obsolete derived constraint', pointer: 'fixture' }] }); }
  else store.message('A later note must survive too.', 'later_note');
  const following = store.load().conversation.work!;
  const current = store.load();
  const operation = UndoAppliedSchema.parse({ schema: 'undo-applied-v1', id: 'older_undo', workId: original.id, followingWorkId: following.id, fromStretch: 1, throughStretch: current.conversation.stretchCount, generation: current.conversation.generation, mode: 'external' });
  const view = store.undo(operation);
  expect(view.conversation.work).toMatchObject({ id: original.id, request: original.request, constraints: [], counters: { stretches: 0 } });
  expect(view.closedWorks).toEqual([expect.objectContaining({ id: following.id, request: following.request, closedAs: 'cancelled', constraints: [], counters: { stretches: 0, reviews: 0, noProgress: 0, testFailures: 0, costUsd: 0, unknownCostStretches: 0 } })]);
  expect(view.stretches.every((step) => step.status === 'undone')).toBe(true);
  expect(view.messages.map((message) => message.text)).toEqual([original.request, following.request, 'A later note must survive too.']);
  const brief = buildBrief(view, ledger, { action: 'reply', project: { name: 'Fixture', branchPolicy: 'main' }, cwd: root, memoryWrite: false }).text;
  expect(brief).toContain(original.request); expect(brief).toContain(following.request); expect(brief).toContain('A later note must survive too.'); expect(brief).not.toContain('obsolete derived constraint');
  expect(new ConversationWork(new ConversationLedger(homes, 'conversation')).recover()).toEqual(view);
  expect(store.undo(operation).conversation.generation).toBe(view.conversation.generation);
  store.close('done'); const fresh = store.message('Fresh request', 'fresh'); expect(fresh.view.conversation.work?.messageEventIds).toEqual([]);
});

test('undo rejects a running step, stale generations, partial ranges and older work without appending an event', () => {
  store.message('Request', 'request'); start(); let operation = undo(1);
  expect(() => store.undo(operation)).toThrow('running stretch'); finish(); store.pins({ effort: 'max' }); expect(() => store.undo(operation)).toThrow('stale');
  start(); finish(); operation = undo(1); expect(() => store.undo({ ...operation, throughStretch: 1 })).toThrow('every active step');
  store.close('done'); store.message('New work', 'new'); expect(() => store.undo({ ...operation, generation: store.load().conversation.generation })).toThrow('newer work');
  expect(ledger.events().filter((event) => event.type === 'undo')).toEqual([]);
});

test('successive undo and redo recompute guards without retaining failed receipts from undone steps', () => {
  store.message('Request', 'request'); store.baseCommit('base');
  const noProgress = (passed: boolean) => {
    const n = start('implement'); ledger.acceptHandoff(HandoffSchema.parse({ schema: 'handoff-v2', stretch: n, action: 'implement', status: 'partial', summary: 'No changes', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: 'implement', changedFiles: [], testsRun: { command: 'test', passed, summary: 'Fixture' } }));
    store.finish(n, { status: 'completed', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }, false);
  };
  noProgress(false); noProgress(false); verification(false); expect(store.load().conversation.work?.counters.testFailures).toBe(3);
  store.undo(undo(2)); expect(store.load().conversation.work?.counters).toMatchObject({ stretches: 1, noProgress: 1, testFailures: 1, unknownCostStretches: 1 });
  noProgress(true); verification(false); start('plan'); finish('plan'); store.undo(undo(4));
  expect(store.load().conversation.work?.counters).toMatchObject({ stretches: 2, noProgress: 2, testFailures: 1, unknownCostStretches: 2, costUsd: 0 });
  expect(store.load().stretches.map((step) => step.status)).toEqual(['completed', 'undone', 'completed', 'undone']);
});

test.each(['waiting', 'running', 'closed'])('conversation rename is durable and leaves %s work and generation unchanged', (state) => {
  store.message('  Preserve this exact request.\nAnd its continuation.  ', 'request');
  if (state === 'running') start(); else if (state === 'closed') store.close('done'); else store.pause('Choose a step.');
  const before = store.load(); const request = { schema: 'rename-conversation-v1', clientRequestId: 'rename', previousTitle: 'Fixture', title: '  A useful conversation title  ' };
  store.rename(request); store.rename(request); const after = store.recover();
  expect(after.conversation).toMatchObject({ title: 'A useful conversation title', generation: before.conversation.generation, state: before.conversation.state });
  expect(after.conversation.work).toEqual(before.conversation.work); expect(after.closedWorks).toEqual(before.closedWorks); expect(after.stretches).toEqual(before.stretches); expect(after.messages).toEqual(before.messages);
  expect(() => store.rename({ ...request, clientRequestId: 'stale', title: 'Stale title' })).toThrow('title changed');
  expect(() => store.rename({ ...request, title: 'Different title' })).toThrow('different content');
  store.rename({ ...request, clientRequestId: 'new_name', previousTitle: after.conversation.title, title: 'Latest title' }); store.rename(request); expect(store.load().conversation.title).toBe('Latest title');
});
test('outside finish is durable, waits for the running stretch, deduplicates and keeps historical reasons after new work', () => {
  store.message('Keep the original request.', 'request'); start(); const before = store.load();
  const request = { schema: 'finish-outside-v1', clientRequestId: 'finish', generation: before.conversation.generation, reason: 'I needed a different approach.' };
  const record = store.requestFinishOutside(request); store.requestFinishOutside(request);
  expect(store.load().conversation.generation).toBe(before.conversation.generation + 1);
  expect(() => store.finishOutsideStatus({ ...record, status: 'completed', retained: false })).toThrow('running stretch');
  expect(() => store.message('New direction', 'new')).toThrow('pending outside outcome');
  finish(); store.finishOutsideStatus({ ...record, status: 'completed', retained: false });
  const after = store.recover(); expect(after.conversation).toMatchObject({ state: 'done', work: null, outcome: { kind: 'finished-elsewhere', reason: request.reason } });
  expect(after.closedWorks[0]).toMatchObject({ id: before.conversation.work!.id, request: 'Keep the original request.', closedAs: 'closed-by-you' }); expect(after.stretches).toHaveLength(1);
  expect(store.requestFinishOutside(request).status).toBe('completed'); expect(() => store.requestFinishOutside({ ...request, reason: 'Changed reason' })).toThrow('different content');
  store.message('A new request.', 'new'); expect(store.load().conversation.outcome).toBeUndefined(); expect(store.load().finishes[0]?.request.reason).toBe(request.reason);
});
test('renames and outside reasons use the ledger redactor before storage', () => {
  const secret = ['private', 'fixture', 'control'].join('-'); const redactor = new SecretRedactor(); redactor.add(secret);
  const privateLedger = new ConversationLedger(homes, 'controls', { redactor }); const privateWork = new ConversationWork(privateLedger);
  privateWork.create({ title: 'Initial', projectId: 'project', ownerDeviceId: 'device' });
  privateWork.rename({ schema: 'rename-conversation-v1', clientRequestId: 'name', previousTitle: 'Initial', title: `Title ${secret}` });
  const record = privateWork.requestFinishOutside({ schema: 'finish-outside-v1', clientRequestId: 'finish', generation: 0, reason: `Reason ${secret}` });
  privateWork.finishOutsideStatus({ ...record, status: 'completed', retained: false });
  expect(JSON.stringify(privateLedger.events())).not.toContain(secret); expect(JSON.stringify(privateWork.recover())).not.toContain(secret);
});
