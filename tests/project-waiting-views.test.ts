import { afterEach, expect, test } from 'vitest';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { waitingItem } from '../packages/projects/dist/waiting-views.js';
import { decision } from './helpers/owner-fixtures.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('waiting-item view supplies source, response, presentation and command scope from the engine', async () => {
  const f = fixture = await projectFixture();
  const id = await f.app.projectWork.decisions.ask('project', { question: 'Fixture choice?', options: [{ label: 'A' }] }, 'coordinator');
  const response = await f.request('/api/projects/project/waiting-items');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ schema: 'project-waiting-items-view-v1', projectId: 'project',
    open: [{ number: 1, source: 'From the coordinator', routedTo: 'Sent to the coordinator.', allowsFreeText: true, paragraphs: null,
      respondPath: `/api/projects/project/waiting-items/${id}/respond`, commandScope: { decisionId: id, cwd: 'checkout', clearDevice: true },
      requestBase: { schema: 'decision-answer-request-v1' } }], answered: [] });
});

test('waiting-item response repeats through the normal answer service and returns the resulting page and feedback', async () => {
  const f = fixture = await projectFixture();
  const id = await f.app.projectWork.decisions.ask('project', { question: 'Fixture choice?', options: [{ label: 'A' }] }, 'coordinator');
  const body = { schema: 'project-waiting-respond-request-v1', answer: { schema: 'decision-answer-request-v1', clientRequestId: 'waiting_answer', optionLabel: 'A' }, view: { resolvedDays: 14 } };
  const route = `/api/projects/project/waiting-items/${id}/respond`, response = await f.request(route, 'POST', body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ schema: 'project-waiting-response-v1', receipt: { repeated: false },
    feedback: { text: 'Sent to the coordinator.', known: [] }, page: { waiting: { open: [], answered: [{ answerSummary: 'A' }], showSent: true } } });
  const repeat = await f.request(route, 'POST', body);
  expect(repeat.status).toBe(200); expect(await repeat.json()).toMatchObject({ receipt: { repeated: true } });
});

test('versioned page read derives feedback lifetime from known open questions without a clock', async () => {
  const f = fixture = await projectFixture();
  const id = await f.app.projectWork.decisions.ask('project', { question: 'Fixture choice?', options: [] }, 'coordinator');
  const response = await f.request('/api/projects/project/status-view', 'POST', { schema: 'project-page-request-v1', resolvedDays: 28, ackKnown: [id] });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ waiting: { showSent: true } });
  await f.app.projectWork.decisions.ask('project', { question: 'Another fixture choice?', options: [] }, 'coordinator');
  const later = await f.request('/api/projects/project/status-view', 'POST', { schema: 'project-page-request-v1', resolvedDays: 28, ackKnown: [id] });
  expect(later.status).toBe(200); expect(await later.json()).toMatchObject({ waiting: { showSent: false } });
});

test('coordinator frames supply a withdrawal notice without browser tool interpretation', async () => {
  const f = fixture = await projectFixture(), ledger = f.app.projectWork.coordinatorLedger('project');
  const entry = ledger.append({ type: 'coordinator-tool', data: { schema: 'coordinator-tool-v1', tool: 'jevellan_withdraw_question', ok: true,
    summary: 'Withdrawn fixture question', decisionId: 'decision_fixture', reason: 'No longer needed.' } });
  const response = await f.request('/api/projects/project/coordinator/events'), reader = response.body!.getReader();
  const decoder = new TextDecoder(); let buffered = '';
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) throw new Error('The coordinator stream ended early.');
      buffered += decoder.decode(next.value, { stream: true });
      const blocks = buffered.split('\n\n'); buffered = blocks.pop()!;
      for (const block of blocks) {
        const data = block.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
        const frame = JSON.parse(data.slice(6)) as { event: { id: number }; notices?: unknown[] };
        if (frame.event.id !== entry.id) continue;
        expect(frame.notices).toEqual([{ schema: 'project-view-notice-v1', id: entry.id, decisionId: 'decision_fixture', text: 'A question was withdrawn: No longer needed.' }]);
        return;
      }
    }
  } finally { await reader.cancel(); }
});

test('waiting presentation preserves deployment revision, free-text refusal, thread scope and chat answer copy', () => {
  const deploy = waitingItem(decision('decision_deploy', 'Deploy fixture?\nExact fixture commit.', { revision: 7, deploy: { deployId: 'deploy_fixture', action: 'approve' } }), 1, () => undefined);
  expect(deploy).toMatchObject({ allowsFreeText: false, requestBase: { schema: 'decision-answer-request-v1', expectedRevision: 7 },
    paragraphs: [{ text: 'Deploy fixture?', strong: true }, { text: 'Exact fixture commit.', strong: false }] });
  const fromThread = waitingItem(decision('decision_thread', 'Fixture choice?', { from: 'thread', threadId: 'thread_fixture' }), 2, () => 'Fixture thread');
  expect(fromThread).toMatchObject({ source: 'From "Fixture thread"', routedTo: 'Sent to "Fixture thread".', allowsFreeText: true,
    commandScope: { threadId: 'thread_fixture', decisionId: 'decision_thread', cwd: 'worktree', clearDevice: false } });
  expect(fromThread.requestBase).not.toHaveProperty('expectedRevision');
  const answered = waitingItem(decision('decision_chat', 'Fixture choice?', { answer: { source: 'owner-chat', ownerMessage: 'A, please.', optionLabel: 'A' } }), 1, () => undefined);
  expect(answered.answerSummary).toBe('Answered in chat: A, please.');
});

test('a non-closing answer response retains the item and does not create sent feedback', async () => {
  const f = fixture = await projectFixture();
  const id = await f.app.projectWork.decisions.ask('project', { question: 'Fixture choice?', options: [] }, 'coordinator');
  f.app.projectWork.answerDecision = async () => ({ repeated: false, closed: false });
  const response = await f.request(`/api/projects/project/waiting-items/${id}/respond`, 'POST', { schema: 'project-waiting-respond-request-v1',
    answer: { schema: 'decision-answer-request-v1', clientRequestId: 'waiting_open', text: 'Fixture answer' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ receipt: { closed: false }, feedback: null, page: { waiting: { open: [{ decision: { id } }], showSent: false } } });
});

test('UI response and owner-tool response produce the same canonical answer state', async () => {
  const f = fixture = await projectFixture();
  const ui = await f.app.projectWork.decisions.ask('project', { question: 'UI fixture choice?', options: [{ label: 'A' }] }, 'coordinator');
  const tool = await f.app.projectWork.decisions.ask('project', { question: 'Tool fixture choice?', options: [{ label: 'A' }] }, 'coordinator');
  expect((await f.request(`/api/projects/project/waiting-items/${ui}/respond`, 'POST', { schema: 'project-waiting-respond-request-v1',
    answer: { schema: 'decision-answer-request-v1', clientRequestId: 'ui_parity', optionLabel: 'A' } })).status).toBe(200);
  await f.app.ownerTools.status(f.project);
  const id = f.app.ownerTools.ids.shortOf('project', tool); expect(id).toBeTruthy();
  const result = await f.app.ownerTools.call('respond', { schema: 'owner-tool-request-v1', caller: 'cli', args: { project: 'project', item: id!, answer: 'A' } });
  expect(result).toMatchObject({ ok: true });
  const uiAnswer = (await f.app.projectHub.decision(ui))!.document.answer!, toolAnswer = (await f.app.projectHub.decision(tool))!.document.answer!;
  expect(uiAnswer.optionLabel).toBe('A');
  expect([uiAnswer.optionLabel, uiAnswer.text, uiAnswer.source]).toEqual([toolAnswer.optionLabel, toolAnswer.text, toolAnswer.source]);
  expect((await f.app.projectWork.waitingView('project')).open).toEqual([]);
});
