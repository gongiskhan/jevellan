import { afterEach, expect, test } from 'vitest';
import { ProjectUsageViewSchema, type ProjectUsageDay } from '../packages/core/dist/index.js';
import { emptyUsage, projectUsageView } from '../packages/projects/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
test('usage presentation owns ranges, empty state, columns and the reported-cost notice', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const empty = projectUsageView('project', 'today', [], now, 'UTC');
  expect(empty).toHaveProperty('presentation');
  const info = empty.presentation!;
  expect(info).toMatchObject({ schema: 'project-usage-presentation-v1', empty: true, emptyMessage: 'No usage in this range.', unknownCostNotice: null });
  expect(info.ranges.map(row => [row.value, row.label])).toEqual([['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']]);
  expect(info.tables.find(table => table.key === 'byThread')?.columns.map(row => row.label)).toEqual(['Thread', 'Models', 'Turns', 'Tokens', 'Cost']);
  const day: ProjectUsageDay = { schema: 'project-usage-day-v1', revision: 0, id: 'usage_fixture', projectId: 'project', deviceId: 'device_fixture', day: '2026-10-21', updatedAt: new Date(now).toISOString(), rows: [{ ...emptyUsage(), kind: 'memory', ownerId: 'fixture_memory', title: 'Memory', runtime: 'fake', modelLabel: 'Fixture', accountLabel: 'Fixture', turns: 1, inputTokens: 100, outputTokens: 20, costUnknownTurns: 1 }] };
  expect(projectUsageView('project', 'today', [day], now, 'UTC')).toMatchObject({ presentation: { empty: false, unknownCostNotice: '1 turns without a reported cost', tables: expect.arrayContaining([expect.objectContaining({ key: 'byKind', rows: expect.arrayContaining([expect.objectContaining({ label: 'Memory', tokens: 120 })]) })]) } });
});

test('usage read defaults and presentation match on a member while old documents remain readable', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  const response = await f.request('/api/projects/project/usage'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ range: 'today', presentation: { defaultRange: 'today', refreshMs: 15000, empty: true } });
  const remote = await member.request('/api/projects/project/usage'); expect(remote.status).toBe(200); expect(await remote.json()).toEqual(view);
  const { presentation, ...old } = view; expect(presentation).toBeDefined(); expect(ProjectUsageViewSchema.safeParse(old).success).toBe(true);
  expect(ProjectUsageViewSchema.safeParse({ ...view, presentation: { ...presentation, unexpected: true } }).success).toBe(false);
  expect((await f.request('/api/projects/project/usage?range=unsupported')).status).toBe(400);
});
