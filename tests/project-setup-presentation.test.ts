import { afterEach, expect, test } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const items = [{ key: 'testCommand' as const, value: 'npm test' }, { key: 'goal' as const, value: 'Keep fixture clear\nCheck the expected actions.' }];

test('setup view returns common item labels without starting work or changing its stored proposal', async () => {
  f = await projectFixture(); await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  const { proposal } = await f.app.projectWork.proposeSetup(f.project.id, 'presentation_fixture', { items });
  const before = await f.app.projectHub.setupProposal(proposal.id), response = await f.request(`/api/projects/${f.project.id}/setup-proposals/${proposal.id}`); expect(response.status).toBe(200);
  const view = await response.json(); expect(view.presentation).toMatchObject({ schema: 'project-setup-presentation-v1', appliedLine: null, items: [{ index: 0, label: 'Test command' }, { index: 1, label: 'Goal: Keep fixture clear' }] });
  expect(await f.app.projectHub.setupProposal(proposal.id)).toEqual(before); expect(f.fake.runs).toHaveLength(0);
});

test('common setup presentation keeps raw first-line goal labels and legacy applied counts', () => {
  const shared = core as unknown as { projectSetupPresentation(proposal: unknown): { schema: string; appliedLine: string | null }; setupGoalLabel(value: string): string; setupApplied(count: number): string };
  const proposal = core.ProjectSetupProposalSchema.parse({ schema: 'project-setup-proposal-v1', revision: 0, id: 'setup_fixture', projectId: 'project', createdAt: '2026-10-21T09:00:00Z', items });
  expect(shared.projectSetupPresentation(proposal).appliedLine).toBe(null); expect(shared.setupGoalLabel('  Raw goal\nMore detail')).toBe('Goal:   Raw goal');
  expect(shared.projectSetupPresentation({ ...proposal, appliedAt: '2026-10-21T09:01:00Z', applied: [1] }).appliedLine).toBe('Setup applied: 1 changes.');
  expect(shared.projectSetupPresentation({ ...proposal, appliedAt: '2026-10-21T09:01:00Z' }).appliedLine).toBe('Setup applied: 0 changes.'); expect(shared.setupApplied(4)).toBe('Setup applied: 4 changes.');
});
