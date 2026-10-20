import { afterEach, expect, test } from 'vitest';
import { forCoordinator } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const call = async (name: string, args: Record<string, unknown> = {}, action?: string) => f!.app.ownerTools.call(name, { schema: 'owner-tool-request-v1', caller: 'bridge:project', args, ...(action ? { action } : {}) });
const text = async (name: string, args: Record<string, unknown> = {}, action?: string) => { const result = await call(name, args, action); return result.ok ? result.text : `ERROR ${result.error.code}: ${result.error.text}`; };

test('work adds, lists, moves, inspects and cancels queued tasks with the specified copy', async () => {
  f = await projectFixture();
  await f.app.projectWork.putSettings('project', { schema: 'project-work-settings-request-v1', revision: (await f.app.projectWork.settingsView('project')).settings.revision,
    settings: { ...(await f.app.projectWork.settingsView('project')).settings, status: 'paused' } } as never).catch(() => undefined);
  expect(await text('work', { action: 'add', title: 'Bump the PDF library', priority: 'urgent' })).toBe('Added T1 as urgent. It starts next.');
  expect(await text('work', { action: 'add', title: 'Fix the typo in the README' })).toMatch(/^Added T2 "Fix the typo in the README" \(manual\) at position 2 of 2\. It starts when a slot is free \(0 of \d+ running\.\)$/u);
  expect(await text('work', { action: 'add', title: 'Third task' })).toMatch(/^Added T3 "Third task" \(manual\) at position 3 of 3\./u);
  expect(await text('work', { action: 'list' })).toBe('1 T1 manual · Bump the PDF library · urgent\n2 T2 manual · Fix the typo in the README\n3 T3 manual · Third task');
  expect(await text('work', { action: 'reorder', task: 'T3', position: '2' })).toBe('Moved T3 to position 2 (was 3).');
  expect(await text('work', { action: 'inspect', task: 't3' })).toMatch(/^T3 Third task\nGoal: manual · origin: owner · priority normal · delivery land\nState: queued/u);
  expect(await text('work', { action: 'cancel', task: 'T2' })).toBe('Cancelled T2 (it was queued).');
  expect(await text('work', { action: 'cancel', task: 'T99' })).toBe('ERROR not_found: T99 is not a task or thread of ' + f.project.name + '.');
  expect(await text('work', { action: 'add' })).toBe('ERROR invalid_arguments: work add: title is required.');
});

test('respond picks options by unique prefix, refuses others with the list, and sends free text to the asker', async () => {
  f = await projectFixture();
  const choice = await f.app.projectWork.decisions.ask('project', { question: 'Which fixture should the tests use?', options: [{ label: 'Existing fixture' }, { label: 'New fixture' }] }, 'coordinator');
  const free = await f.app.projectWork.decisions.ask('project', { question: 'What should the release be called?' }, 'coordinator');
  const status = await text('status');
  expect(status).toContain('W1 Which fixture should the tests use? Options: Existing fixture, New fixture');
  expect(status).toContain('W2 C asks: What should the release be called?');
  expect(await text('respond', { item: 'W1', answer: 'fixture' })).toBe('ERROR invalid_answer: W1 takes Existing fixture, New fixture.');
  expect(await text('respond', { item: 'W1', answer: 'existing' })).toBe('Answered W1: Existing fixture.');
  expect(await text('respond', { item: 'W2', answer: 'Spring' })).toBe('Sent your answer to the coordinator.');
  expect(await text('respond', { item: 'W1', answer: 'existing' })).toBe('ERROR not_open: W1 is no longer waiting on you.');
  const view = await f.app.projectWork.view('project');
  expect(view.decisions.answered.map(row => [row.id, row.answer?.optionLabel ?? row.answer?.text])).toEqual(expect.arrayContaining([[choice, 'Existing fixture'], [free, 'Spring']]));
});

test('ask_coordinator tell reaches the coordinator as the owner via the bridge; config reads and changes bridge settings', async () => {
  f = await projectFixture({ coordinator: true });
  f.fake.enqueueTurn(async turn => { turn.say('Will do.'); return { status: 'completed' }; }, forCoordinator);
  expect(await text('ask_coordinator', { mode: 'tell', text: 'Finish the parser work before anything new.' })).toMatch(/^Sent to the coordinator\. It sees it at its next turn \(it is \w+ now\)\.$/u);
  await f.waitFor(() => f!.coordinatorState().queue.length === 0 || f!.fake.turnStarts.length > 0);
  expect(f.fake.turnStarts.at(-1)?.prompt ?? '').toContain('Finish the parser work before anything new.');
  expect(await text('config', { action: 'get', section: 'push' })).toBe('push: transport channel · batchSeconds 60 · every kind on');
  expect(await text('config', { action: 'set', section: 'push', key: 'transport', value: 'inject' })).toBe('Changed push.transport from channel to inject. The bridge uses it from its next start (jevellan bridge --restart).');
  expect(await text('config', { action: 'set', section: 'push', key: 'transport', value: 'smoke' })).toBe('ERROR invalid_value: push.transport must be channel, inject or none.');
  expect(await text('config', { action: 'get' })).toMatch(/^accounts: .*\nlimits: maxRunningThreadsAll 6 · maxRunningThreads \d+\ndeploy: mode approve · paused no · debounce 10 min\n/u);
});

test('activity digests the period and thread say and stop refuse what they cannot do', async () => {
  f = await projectFixture();
  expect(await text('activity', { since: 'last night' })).toMatch(/^\S+ since yesterday 20:00\nLanded: nothing\nDeployed: nothing\nRolled back: nothing\nNight: nothing ran\nFailed: nothing\nMissed: none\nDecisions: 0 by Jev, 0 by the coordinator, 0 overridden\nNew waiting items: none$/u);
  expect(await text('activity', { since: 'whenever' })).toBe('ERROR invalid_since: since takes an ISO time, HH:MM, "N minutes", "N hours", "today" or "last night".');
  expect(await text('thread', { action: 'open', thread: 'C' })).toBe("ERROR coordinator: The coordinator can't be taken over. Ask it something or tell it what to do instead.");
  await f.app.projectWork.createTask('project', { schema: 'task-create-request-v1', clientRequestId: 'held_one', title: 'Queued one', brief: 'Queued one.', type: 'feature', goalId: null, now: false, held: true, after: [], needs: [], fixed: {} });
  expect(await text('thread', { action: 'say', thread: 'T1', text: 'Use the existing fixture.' })).toBe('T1 has not started. Your message is attached to its task and it sees it when it starts.');
  expect(f.app.ownerTools.steeringRecords('project')).toMatchObject([{ thread: 'T1', kind: 'say', text: 'Use the existing fixture.', by: 'bridge' }]);
});
