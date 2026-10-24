import { afterEach, expect, test } from 'vitest';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { coordinatorPresentation, CoordinatorActivityProjector } from '../packages/projects/dist/coordinator-view.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('the project page receives coordinator presentation and control eligibility from the engine', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/projects/project/status-view');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ header: { current: { working: false, chip: { label: 'Idle', tone: 'idle' },
    contextLine: null, controls: { canFresh: true, canSuggestSetup: true } } } });
  for (const query of ['timeZone=not-a-time-zone', 'locale=_bad']) expect((await f.request(`/api/projects/project/status-view?${query}`)).status).toBe(400);
});

test('pending fresh-start presentation preserves the current context notice in every coordinator state', async () => {
  const f = fixture = await projectFixture(), view = (await f.app.projectWork.pageView('project')).work;
  view.coordinator.freshPending = true;
  view.coordinator.session = { runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Test', turns: 1,
    context: { schema: 'project-session-context-v1', tokens: null, contextWindow: null, thresholdPercent: 70,
      compactions: [], lastCompactionAt: null, needsFreshContext: false, notice: 'Current context information remains available.' } };
  for (const state of ['idle', 'running', 'unavailable', 'offline'] as const) {
    view.coordinator.state = state;
    const header = coordinatorPresentation(view);
    expect(header.current.contextNotice).toContain('Fresh start pending');
    expect(header.current.contextNotice).toContain('Current context information remains available.');
    if (header.live) {
      expect(header.live.working.contextNotice).toBe(header.current.contextNotice);
      expect(header.live.idle.contextNotice).toBe(header.current.contextNotice);
    }
  }
  delete view.coordinator.freshPending;
  expect(coordinatorPresentation(view).current.contextNotice).toBe('Current context information remains available.');
});

test('coordinator presentation keeps unavailable snapshots authoritative and counts compactions in the viewer day', async () => {
  const f = fixture = await projectFixture(), page = await f.app.projectWork.pageView('project');
  const view = page.work;
  view.coordinator.session = { runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Test', turns: 2,
    context: { schema: 'project-session-context-v1', tokens: 64000, contextWindow: 128000, thresholdPercent: 70,
      compactions: ['2026-10-19T12:00:00Z', '2026-10-20T00:00:00Z'], lastCompactionAt: '2026-10-20T00:00:00Z', needsFreshContext: false } };
  const options = { now: Date.parse('2026-10-20T00:30:00Z'), timeZone: 'America/New_York', locale: 'en-GB', runtimeName: () => 'Test runtime' };
  const header = coordinatorPresentation(view, options);
  expect(header.current.contextLine).toBe('Context 50% · Compacted 2 times today · Last compaction 20:00');
  expect(header.current.chip.session).toBe('Test runtime Fixture · medium');
  expect(coordinatorPresentation(view, { ...options, timeZone: 'UTC' }).current.contextLine).toBe('Context 50% · Compacted 1 times today · Last compaction 00:00');
  expect(header.live?.working).toMatchObject({ working: true, chip: { label: 'Working…' }, controls: { canSuggestSetup: false, canFresh: true } });
  for (const state of ['running', 'unavailable', 'offline'] as const) {
    view.coordinator.state = state;
    const snapshot = coordinatorPresentation(view, options);
    expect(snapshot.live).toBeNull(); expect(snapshot.current.working).toBe(state === 'running');
    expect(snapshot.current.controls.canFresh).toBe(state !== 'offline');
    expect(snapshot.current.controls.canSuggestSetup).toBe(state === 'unavailable');
  }
  view.settings.status = 'archived';
  const archived = coordinatorPresentation(view, options);
  expect(archived.banner).toMatchObject({ actionLabel: 'Unarchive', request: { revision: view.settings.revision, settings: { status: 'paused' } } });
  const projector = new CoordinatorActivityProjector();
  expect(projector.observe({ schema: 'project-ledger-event-v1', id: 4, t: new Date(options.now).toISOString(), type: 'coordinator-turn-start',
    data: { schema: 'coordinator-turn-v1', turn: 2, fresh: false, runtime: 'fake', modelLabel: 'Fake', effort: 'medium', accountLabel: 'Test', eventIds: [] } }).state).toBe('working');
  expect(projector.observe({ schema: 'project-ledger-event-v1', id: 3, t: new Date(options.now).toISOString(), type: 'coordinator-turn-end',
    data: { schema: 'coordinator-turn-end-v1', turn: 2, status: 'completed' } })).toMatchObject({ seq: 3, state: 'idle' });
  expect(projector.observe({ schema: 'project-ledger-event-v1', id: 5, t: new Date(options.now).toISOString(), type: 'notice',
    data: { schema: 'project-notice-v1', text: 'Fixture notice', kind: 'info' } })).toMatchObject({ seq: 5, state: 'working' });
});

test('project status actions preserve unrelated settings and refuse stale revisions', async () => {
  const f = fixture = await projectFixture();
  const settings = await f.app.projectWork.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, status: 'paused', instructions: 'Preserve the fixture instructions.' }, settings.revision);
  const paused = await f.app.projectWork.admission.settings('project');
  const page = await (await f.request('/api/projects/project/status-view')).json() as { header?: { banner?: { request: unknown } } };
  expect(page.header?.banner).toBeDefined();
  const body = page.header!.banner!.request;
  const response = await f.request('/api/projects/project/work-settings', 'PUT', body);
  expect(response.status).toBe(200);
  const resumed = await f.app.projectWork.admission.settings('project');
  expect(resumed).toMatchObject({ status: 'active', instructions: paused.instructions });
  expect((await f.request('/api/projects/project/work-settings', 'PUT', body)).status).toBe(409);
});

test('coordinator stream projects activity, ignores another turn ending and resumes idle on the matching end', async () => {
  const f = fixture = await projectFixture(), ledger = f.app.projectWork.coordinatorLedger('project');
  const start = ledger.append({ type: 'coordinator-turn-start', data: { schema: 'coordinator-turn-v1', turn: 1, fresh: false,
    runtime: 'fake', modelLabel: 'Fake', effort: 'medium', accountLabel: 'Test', eventIds: [] } });
  const response = await f.request('/api/projects/project/coordinator/events');
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffered = '';
  const frames: Array<{ event: { id: number }; coordinatorActivity?: unknown }> = [];
  const through = async (id: number) => {
    for (;;) {
      const found = frames.find(frame => frame.event.id === id); if (found) return found;
      const next = await reader.read(); if (next.done) throw new Error('The coordinator stream ended early.');
      buffered += decoder.decode(next.value, { stream: true });
      const blocks = buffered.split('\n\n'); buffered = blocks.pop()!;
      for (const block of blocks) {
        const data = block.split('\n').find(line => line.startsWith('data: '));
        if (data) frames.push(JSON.parse(data.slice(6)) as typeof frames[number]);
      }
    }
  };
  try {
    expect((await through(start.id)).coordinatorActivity).toMatchObject({ schema: 'project-coordinator-activity-v1', seq: start.id, state: 'working' });
    const other = ledger.append({ type: 'coordinator-turn-end', data: { schema: 'coordinator-turn-end-v1', turn: 2, status: 'completed' } });
    expect((await through(other.id)).coordinatorActivity).toMatchObject({ seq: other.id, state: 'working' });
    const end = ledger.append({ type: 'coordinator-turn-end', data: { schema: 'coordinator-turn-end-v1', turn: 1, status: 'completed' } });
    expect((await through(end.id)).coordinatorActivity).toMatchObject({ seq: end.id, state: 'idle' });
  } finally { await reader.cancel(); }
});
