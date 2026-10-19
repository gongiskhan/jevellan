import { afterEach, expect, test } from 'vitest';
import { OwnerSchedules } from '../apps/daemon/dist/owner-schedules.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const text = async (args: Record<string, unknown>) => { const result = await f!.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'bridge:project', args }); return result.ok ? result.text : `ERROR ${result.error.code}: ${result.error.text}`; };
async function night(fixture: ProjectFixture) {
  const daily = fixture.app.projectWork.daily;
  const suite = await daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'suite', name: 'Full suite', goalId: null, enabled: true, run: { kind: 'command', command: 'true', timeoutMinutes: 5 }, gate: null });
  const intake = await daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'intake', name: 'Intake', goalId: null, enabled: true, run: { kind: 'command', command: 'true', timeoutMinutes: 5 }, gate: null });
  await daily.updateJob('project', suite.id, { schema: 'job-update-request-v1', expectedRevision: suite.revision, name: suite.name, goalId: null, enabled: true, run: suite.run, gate: null });
  await daily.updateJob('project', intake.id, { schema: 'job-update-request-v1', expectedRevision: intake.revision, name: intake.name, goalId: null, enabled: true, run: intake.run, gate: null });
  await daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'night_suite', name: 'Full suite', goalId: null, order: 0, enabled: true, target: { kind: 'job', jobId: suite.id } });
  await daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'night_review', name: 'Review since last', goalId: null, order: 1, enabled: true, target: { kind: 'session', title: 'Review since last', brief: 'Review.', type: 'review' } });
  const view = await fixture.app.projectWork.settingsView('project');
  await fixture.app.projectWork.putSettings('project', { schema: 'project-work-settings-request-v1', revision: view.settings.revision, settings: { ...view.settings, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } } } as never);
}

test('jobs lists the window, items and command jobs, and changes when things run', async () => {
  f = await projectFixture({ control: true });
  await night(f);
  const list = await text({ action: 'list' });
  expect(list).toMatch(/^Jobs for \S+ \(Lisbon time\)\nNight window: 01:00 · order: Full suite, Review since last\nCommand jobs: intake\nLast runs: none\nMissed in the last 7 days: none\nPaused: none$/u);
  expect(await text({ action: 'schedule', job: 'night', windowStart: '00:30', text: 'move the night to half past midnight' })).toBe('The night window now starts at 00:30. Tonight\'s order: Full suite, Review since last.');
  expect((await f.app.projectWork.settingsView('project')).settings.nightlyWindow.time).toBe('00:30');
  expect(await text({ action: 'schedule', job: 'review', order: ['review', 'full suite'], text: 'review first' })).toBe("Tonight's order: Review since last, Full suite.");
  expect(await text({ action: 'pause', job: 'review' })).toBe("Paused Review since last. It won't run until you resume it.");
  expect(await text({ action: 'list' })).toContain('Paused: Review since last');
  expect(await text({ action: 'resume', job: 'review' })).toBe('Resumed Review since last. Next run: tonight at 00:30.');
  expect(await text({ action: 'schedule', job: 'review', days: ['mon', 'thu'], text: 'mondays and thursdays' })).toBe('Review since last now runs on Mondays, Thursdays.');
  expect(await text({ action: 'schedule', job: 'intake', everyMinutes: 10, between: '08:00-23:00', text: 'every ten minutes in the day' })).toMatch(/^Intake now runs every 10 minutes between 08:00 and 23:00\. Next: .+\.$/u);
  expect(await text({ action: 'list' })).toContain('Command jobs: intake (every 10 min, 08:00 to 23:00)');
  expect(await text({ action: 'pause', job: 'intake' })).toBe("Paused Intake. It won't run until you resume it.");
  expect(await text({ action: 'show', job: 'nothing' })).toMatch(/^ERROR job_not_found: No job or night item matches "nothing"\. Known: /u);
  expect(await text({ action: 'schedule', job: 'review', text: 'whenever' })).toBe('ERROR invalid_schedule: schedule takes windowStart (HH:MM), order (night items), days (mon to sun) or everyMinutes with between (HH:MM-HH:MM).');
  expect(await text({ action: 'rollback' })).toBe('ERROR rollback_unavailable: Rollback not available: nothing was deployed through Jevellan yet.');
  expect(await text({ action: 'health' })).toBe('No health checks are configured.');
});

test('a night the state point slept through is missed once, caught up inside the window, skipped after it', async () => {
  f = await projectFixture({ control: true });
  await night(f);
  let now = Date.now(); const schedules = new OwnerSchedules(f.app, () => now);
  const items = ['Full suite', 'Review since last'];
  expect(await schedules.nightGuard('project', '2026-10-18', 3 * 3600_000, items)).toEqual({ open: true });
  expect(schedules.missed('project', 7)).toEqual([]);
  expect(await schedules.nightGuard('project', '2026-10-18', 9 * 3600_000, items)).toEqual({ open: true });
  expect(schedules.missed('project', 7)).toMatchObject([{ date: '2026-10-18', caughtUp: true, items }]);
  const skipped = await schedules.nightGuard('project', '2026-10-19', 12 * 3600_000, items);
  expect(skipped).toMatchObject({ open: false, outcome: expect.stringMatching(/^Missed: .+ Outside the 4-hour catch-up window; the items run the next night\.$/u) });
  const pushes = f.app.ownerPushes.describe('project').filter(line => line.includes('night_missed'));
  expect(pushes).toHaveLength(2);
  expect(pushes[1]).toMatch(/Missed last night's Full suite, Review since last \(.+\)\. Outside the catch-up window; they run tonight\./u);
  now += 1;
  expect(await f.app.ownerTools.missedNights('project', 7)).toHaveLength(2);
});

test('interval jobs are due only inside their hours and after their interval', async () => {
  f = await projectFixture({ control: true });
  const at = (clock: string) => Date.parse(`2026-10-20T${clock}:00.000+01:00`);
  let now = at('09:00'); const schedules = new OwnerSchedules(f.app, () => now);
  const interval = { everyMinutes: 10, start: '08:00', end: '23:00' };
  expect(schedules.due(interval, null, 'Europe/Lisbon')).toBe(true);
  expect(schedules.due(interval, new Date(at('08:55')).toISOString(), 'Europe/Lisbon')).toBe(false);
  expect(schedules.due(interval, new Date(at('08:50')).toISOString(), 'Europe/Lisbon')).toBe(true);
  now = at('23:30'); expect(schedules.due(interval, null, 'Europe/Lisbon')).toBe(false);
  expect(schedules.nextInterval(interval, null, 'Europe/Lisbon')).toMatch(/ 08:00$/u);
});

test('the deploy switch approves through the owner path in nightly mode, holds database changes, and pauses after a failed automatic deploy', async () => {
  const at = Date.parse('2026-10-20T05:00:00.000Z'); let now = at;
  const store = new (await import('./helpers/owner-fixtures.js')).MemoryStore();
  const answers: unknown[] = []; const pushes: string[] = []; let database = false; let paused = false;
  const record = { id: 'deploy_1', state: 'open', commit: 'c'.repeat(40), suite: { commit: 'c'.repeat(40), conclusion: 'passed' }, threads: [{ threadId: 'thread_1', title: 'Fix', landingCommit: 'c'.repeat(40) }] };
  const decision = { id: 'decision_1', revision: 3, deploy: { deployId: 'deploy_1', action: 'approve' }, options: [{ label: 'Deploy ccccccc' }, { label: 'Not now' }] };
  let mode = 'approve';
  const app = { hub: store, projectWork: {
      view: async () => ({ settings: { deploy: { mode }, nightlyWindow: { timezone: 'Europe/Lisbon' } }, decisions: { open: [decision] }, threads: [{ id: 'thread_1', landing: { at: new Date(at - 3600_000).toISOString() } }] }),
      deploys: { view: async () => ({ records: [record] }), changesDatabase: async () => database },
      answerDecision: async (...args: unknown[]) => { answers.push(args); }, daily: { view: async () => ({ jobs: [], runs: [], tasks: [] }) } },
    ownerTools: { projects: async () => [{ id: 'project', name: 'sandbox' }], projectSettings: () => ({ deploy: { paused, debounceMinutes: 10 } }), updateProjectSettings: () => { paused = true; }, ids: { one: () => 'W1' } },
    ownerPushes: { add: (push: { text: string }) => { pushes.push(push.text); } }, ownerEvents: { publish: () => undefined } };
  const schedules = new OwnerSchedules(app as never, () => now);
  await schedules.autoDeploy(); expect(answers).toEqual([]);
  mode = 'nightly'; database = true; await schedules.autoDeploy();
  expect(answers).toEqual([]); expect(pushes).toEqual(['Deploy ccccccc is ready, but it changes the database, so it waits for your approval.']);
  database = false; await schedules.autoDeploy();
  expect(answers).toMatchObject([['project', 'decision_1', { schema: 'decision-answer-request-v1', expectedRevision: 3, optionLabel: 'Deploy ccccccc' }]]);
  record.state = 'failed'; now += 60_000; await schedules.autoDeploy();
  expect(paused).toBe(true); expect(pushes.at(-1)).toBe('Deploy ccccccc failed. Automatic deploys are paused until you resume them.');
});
