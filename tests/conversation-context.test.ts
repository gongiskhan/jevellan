import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionRecordSchema, HandoffSchema, Homes, StretchSchema, UndoAppliedSchema, type DecisionRecord, type Handoff, type Stretch } from '../packages/core/dist/index.js';
import { ConversationLedger, ConversationWork } from '../packages/conversations/dist/index.js';
import { conversationHistory, latestMessageNeedsResponse } from '../packages/conversations/dist/conversation-context.js';

let root: string; let ledger: ConversationLedger; let work: ConversationWork; let decisions: DecisionRecord[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-conversation-context-')); mkdirSync(join(root, 'user'));
  ledger = new ConversationLedger(new Homes(join(root, 'data'), join(root, 'user')), 'conversation'); work = new ConversationWork(ledger); decisions = [];
  work.create({ title: 'Fixture', projectId: 'project', ownerDeviceId: 'device' }); work.message('Inspect this project.', 'first');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function decide(action: 'reply' | 'done' = 'reply', legacy = false): DecisionRecord {
  const view = work.load();
  const record = DecisionRecordSchema.parse({ schema: 'decision-v2', id: `decision_${decisions.length + 1}`, conversationId: ledger.id, workId: view.conversation.work!.id,
    n: decisions.length + 1, generation: view.conversation.generation, trigger: 'user-message', at: new Date().toISOString(), latencyMs: 0,
    ...(legacy ? {} : { latestMessageEventId: view.messages.at(-1)!.id }), action: { chosen: action, source: 'manual', allowed: [action] }, correctionsShown: [], notices: [] });
  decisions.push(record); ledger.append({ type: 'decision', data: record }); return record;
}
function start(record = decide()): number {
  const view = work.load(); const n = view.conversation.stretchCount + 1;
  work.start(StretchSchema.parse({ schema: 'stretch-v2', n, workId: view.conversation.work!.id, action: 'reply', modelId: 'model', runtime: 'claude', model: 'model',
    effortRequested: 'low', effortEffective: 'low', accountId: 'account', deviceId: 'device', decisionId: record.id, startedAt: new Date().toISOString(), status: 'running',
    usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }), view.conversation.generation);
  return n;
}
function finish(text = '', status: Stretch['status'] = 'completed', extra: Partial<Handoff> = {}) {
  const n = work.load().conversation.stretchCount;
  if (text) work.runtimeEvent('text', { type: 'text', delta: text }, n);
  ledger.acceptHandoff(HandoffSchema.parse({ schema: 'handoff-v2', stretch: n, action: 'reply', status: 'done', summary: 'Inspection finished.',
    evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [], ...extra }));
  work.finish(n, { status, usage: { inputTokens: 1, outputTokens: 1, costSource: 'unknown' } }, false);
}
function undo(n: number) {
  const view = work.load();
  work.undo(UndoAppliedSchema.parse({ schema: 'undo-applied-v1', id: `undo_${n}`, workId: view.conversation.work!.id, fromStretch: n,
    throughStretch: view.conversation.stretchCount, generation: view.conversation.generation, mode: 'unchanged' }));
}

test('a routing decision never consumes a new user message; a completed response does', () => {
  expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  decide('done'); expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  start(); finish('The project is a small calculator.'); expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
  work.pause('Choose what happens next.'); work.message('Summarize that briefly.', 'summary');
  expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  decide('done'); expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  start(); finish('It adds and subtracts numbers.'); expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
});
test.each(['note', 'user-message'] as const)('a %s received after launch remains pending after the older stretch completes', type => {
  start(); work.message('Explain only the important result.', 'during-run', type); finish('Original inspection output.');
  expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  start(); finish('The important result.'); expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
});
test.each(['failed', 'interrupted', 'timed-out'] as const)('%s output cannot satisfy a pending response', status => {
  start(); finish('Partial output before stopping.', status);
  expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
});
test.each(['blocked', 'partial'] as const)('a completed stretch with a real %s handoff can respond while Jev decides what remains', status => {
  start(); finish('I need the deployment target before changing anything.', 'completed', { status });
  expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
});
test('a synthesized failed handoff or missing response decision does not satisfy the message', () => {
  start(); finish('', 'completed', { status: 'failed', summary: 'Stretch ended without a handoff.' });
  expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  start(); finish('A completed answer.'); expect(latestMessageNeedsResponse(work, [])).toBe(true);
});
test('undo restores the pending response and excludes the undone answer from history', () => {
  start(); finish('Discard this incorrect answer.'); expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
  undo(1); expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  expect(conversationHistory(work.load(), ledger)).not.toContain('Discard this incorrect answer.');
});
test('legacy decisions use launch chronology and cannot consume a message queued afterwards', () => {
  start(decide('reply', true)); finish('Legacy response.'); expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
  work.message('Another question.', 'next'); start(decide('reply', true)); work.message('Queued question.', 'queued', 'note'); finish('Older response.');
  expect(latestMessageNeedsResponse(work, decisions)).toBe(true);
  start(decide('reply', true)); finish('Answer to the queued question.'); expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
});
test('old work responses cannot satisfy a new request, including after recovery', () => {
  start(); finish('Old answer.'); work.close('done'); expect(latestMessageNeedsResponse(work, decisions)).toBe(false);
  work.message('What does that imply?', 'new-work');
  const recovered = new ConversationWork(ledger); recovered.recover();
  expect(latestMessageNeedsResponse(recovered, decisions)).toBe(true);
});

test('history preserves actual streamed answers across closed and current work, with immutable pointers', () => {
  const original = work.load().messages[0]!; const n = start();
  const firstText = work.runtimeEvent('text', { type: 'text', delta: 'The project ' }, n);
  const lastText = work.runtimeEvent('text', { type: 'text', delta: 'adds and subtracts numbers.' }, n);
  finish('', 'completed', { summary: 'Summary only.' });
  work.close('done'); work.message('What does that imply?', 'new-work'); start(); finish('It is suitable for arithmetic exercises.');
  work.message('TL;DR, please.', 'latest');
  const text = conversationHistory(work.load(), ledger);
  for (const expected of [original.text, `ledger/${original.id}`, 'The project adds and subtracts numbers.', `ledger/${firstText.id}`, `ledger/${lastText.id}`, 'handoffs/1', 'What does that imply?', 'It is suitable for arithmetic exercises.']) expect(text).toContain(expected);
  expect(text).not.toContain('Summary only.'); expect(text).not.toContain('TL;DR, please.');
  expect(ledger.read(`ledger/${firstText.id}`)).toMatchObject({ data: { delta: 'The project ' } });
});
test('a saved answer takes priority over streamed narration, then falls back to the handoff summary', () => {
  start(); const answer = ledger.putBlob('The full result: the parser preserves signed numbers.');
  finish('I am checking the parser. Stop hook finished.', 'completed', { summary: 'A short handoff introduction.', result: { type: 'answer', ref: answer.ref } });
  work.message('Explain another detail.', 'detail'); start(); finish('', 'completed', { summary: 'The fallback explanation.' });
  work.message('Make that shorter.', 'latest');
  const text = conversationHistory(work.load(), ledger);
  expect(text).toContain('The full result: the parser preserves signed numbers.'); expect(text).toContain(answer.ref);
  expect(text).not.toContain('I am checking the parser.'); expect(text).not.toContain('Stop hook finished.');
  expect(text).not.toContain('A short handoff introduction.'); expect(text).toContain('The fallback explanation.'); expect(text).toContain('handoffs/2');
  expect(ledger.read(answer.ref)).toBe('The full result: the parser preserves signed numbers.');
});
test('history ignores thinking and tool payloads, but labels partial failed output as historical', () => {
  const n = start(); work.runtimeEvent('thinking', { type: 'thinking', delta: 'Internal reasoning.' }, n);
  work.runtimeEvent('tool-start', { type: 'tool-start', id: 'tool', name: 'Read', input: { path: 'private-input.ts' } }, n);
  work.runtimeEvent('tool-end', { type: 'tool-end', id: 'tool', ok: false, output: 'Verbose tool output.' }, n);
  finish('I could inspect only the entry point.', 'failed', { status: 'failed' }); work.message('What did you find?', 'latest');
  const text = conversationHistory(work.load(), ledger);
  expect(text).toContain('I could inspect only the entry point.'); expect(text).toContain('failed');
  for (const absent of ['Internal reasoning.', 'private-input.ts', 'Verbose tool output.']) expect(text).not.toContain(absent);
});
test('a filtered history view retains the earlier request while the current latest message remains separate', () => {
  start(); finish('First answer.'); work.close('done'); work.message('Latest request.', 'new-work');
  const view = work.load(); const historical = { ...view, messages: view.messages.filter(message => message.workId !== view.conversation.work!.id) };
  const text = conversationHistory(historical, ledger);
  expect(text).toContain('Inspect this project.'); expect(text).toContain('First answer.'); expect(text).not.toContain('Latest request.');
});
test('a bounded history preserves the latest answer even when a long later user message would fill its budget', () => {
  start(); finish('Old response '.repeat(1000)); work.message('Explain the next part.', 'next');
  start(); const answer = 'LATEST ANSWER: this is the conclusion. ' + 'Supporting context. '.repeat(1000) + 'Final limitation: the sign-in is still required.';
  finish(answer); work.message('A long queued correction. '.repeat(1000), 'long'); work.message('Summarize your latest answer.', 'latest');
  const text = conversationHistory(work.load(), ledger, 1200);
  expect(text.length).toBeLessThanOrEqual(1200); expect(text).toContain('LATEST ANSWER: this is the conclusion.'); expect(text).toContain('Final limitation: the sign-in is still required.');
  expect(text).toContain('Excerpt truncated'); expect(text).toContain('source ledger/'); expect(text).not.toContain('Summarize your latest answer.');
  for (const budget of [0, 1, 20, 100, 300, 8000]) expect(conversationHistory(work.load(), ledger, budget).length).toBeLessThanOrEqual(budget);
});
