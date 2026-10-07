import { afterEach, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectAppSchema, CoordinatorMessageReceiptSchema, ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { forCoordinator, forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
test('an app started through a thread bridge survives a done report and is stopped by daemon shutdown', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture(); await writeFile(join(f.checkout, 'index.html'), 'Live fixture app');
  let link = ''; let failure = '';
  f.fake.enqueueTurn(async turn => {
    try {
      const app = ProjectAppSchema.parse(await turn.bridge('jevellan_app_start', { kind: 'static', directory: f.checkout })); link = app.url;
      await turn.bridge('jevellan_thread_report', { status: 'done', summary: `App running: ${link}`, changedFiles: [] });
    } catch (error) { failure = String(error); }
    return { status: 'completed' };
  }, forThread());
  const created = await f.json(`/api/projects/${f.project.id}/threads`, ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'request_managed_app', title: 'Run app', task: 'Start the app and return a usable URL.' });
  await f.waitFor(() => link || failure); expect(failure).toBe('');
  await f.waitFor(() => f.thread(created.threadId).state, state => state === 'done');
  expect(await (await fetch(link)).text()).toBe('Live fixture app');
  expect(f.app.projectWork.apps.list(f.project.id)).toMatchObject([{ state: 'running', url: link }]);
  await f.restart(); await expect(fetch(link)).rejects.toThrow();
});

test('Jev interprets a contextual run request once and the coordinator receives the app completion requirement', { timeout: 120000 }, async () => {
  const requests: Array<{ state: string; questions: Record<string, { criteria: Record<string, string> }> }> = [];
  const f = fixture = await projectFixture({ coordinator: true, jevKey: true, decisionFetch: async (_url, options) => {
    const request = JSON.parse(String(options?.body)); requests.push(request);
    const goal = requests.length === 1 ? 'answer' : 'run-app';
    return Response.json({ model: 'jev-fixture', usage: { input_tokens: 3, output_tokens: 2 }, answers: { outcome: { type: 'choice', choice: goal, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(request.questions.outcome.criteria).map(key => [key, Number(key === goal)])) } } });
  } });
  const prompts: string[] = [];
  f.fake.enqueueTurn(turn => { prompts.push(turn.input.prompt); turn.say('This is a static todo app in index.html.'); return { status: 'completed' }; }, forCoordinator);
  f.fake.enqueueTurn(turn => { prompts.push(turn.input.prompt); turn.say('Starting the app and returning its browser link.'); return { status: 'completed' }; }, forCoordinator);
  const path = `/api/projects/${f.project.id}/coordinator/messages`;
  await f.json(path, CoordinatorMessageReceiptSchema, 'POST', { schema: 'coordinator-message-request-v1', clientMessageId: 'request_context', text: 'What is this app?' });
  await f.app.projectWork.idle(f.project.id);
  const message = { schema: 'coordinator-message-request-v1', clientMessageId: 'request_run', text: 'run it for me' };
  await f.json(path, CoordinatorMessageReceiptSchema, 'POST', message); await f.app.projectWork.idle(f.project.id);
  expect(JSON.parse(requests[1]!.state).conversation).toMatchObject({ latestUserMessage: 'run it for me', recent: expect.stringContaining('static todo app') });
  expect(prompts[1]).toContain('Start it, keep it available and return a working link accessible from their browser.');
  expect(prompts[1]).toContain('Tests or opening a file on the server do not satisfy this outcome.');
  expect((await f.json(path, CoordinatorMessageReceiptSchema, 'POST', message)).repeated).toBe(true); await f.app.projectWork.idle(f.project.id); expect(requests).toHaveLength(2);
});
