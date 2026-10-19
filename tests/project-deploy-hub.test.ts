import { afterEach, expect, test } from 'vitest';
import { ProjectDeploySchema } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const at = '2026-10-19T12:00:00.000Z';
const row = () => ProjectDeploySchema.parse({ schema: 'project-deploy-v1', id: 'deploy_1', projectId: 'project', revision: 0, state: 'open', commit: 'a'.repeat(40), previousCommit: 'b'.repeat(40), threads: [], suite: { commit: 'a'.repeat(40), conclusion: null }, health: { before: [], after: [] }, checks: [], rollbackAvailable: true, decisionId: 'deploy_decision', createdAt: at, updatedAt: at });
test('members read typed deploy records but only the assigned coordinator can advance them', async () => {
  const f = fixture = await projectFixture(); await f.app.projectWork.coordinators.ensureAssigned('project'); const member = await projectMember(f);
  const created = await f.app.projectHub.putDeploy(row(), 0); expect(created.revision).toBe(1);
  expect((await member.app.projectHub.deploys('project')).records[0]?.id).toBe(created.document.id);
  expect((await member.app.projectHub.deploy(created.document.id))?.document.commit).toBe(created.document.commit);
  await expect(member.app.projectHub.putDeploy({ ...created.document, state: 'approved' }, created.revision)).rejects.toThrow('coordinator');
  const approved = await f.app.projectHub.putDeploy({ ...created.document, state: 'approved' }, created.revision);
  await expect(f.app.projectHub.putDeploy({ ...approved.document, commit: 'c'.repeat(40) }, approved.revision)).rejects.toThrow('cannot change its commit');
  await expect(f.app.projectHub.putDeploy({ ...approved.document, failure: 'Stale write' }, created.revision)).rejects.toThrow();
});
test('Not now crosses the owner API without closing the item and coordinator chat cannot approve', async () => {
  const f = fixture = await projectFixture(); await f.app.projectWork.coordinators.ensureAssigned('project'); const created = await f.app.projectHub.putDeploy(row(), 0);
  const decision = (await f.app.projectHub.createDecision({ schema: 'project-decision-v1', id: 'deploy_decision', projectId: 'project', revision: 0, from: 'coordinator', question: 'Deploy?', options: [{ label: 'Deploy aaaaaaa' }, { label: 'Not now' }], deploy: { deployId: created.document.id, action: 'approve' }, createdAt: at })).document;
  const result = await f.request('/api/projects/project/decisions/deploy_decision/answer', 'POST', { schema: 'decision-answer-request-v1', clientRequestId: 'not_now', expectedRevision: decision.revision, optionLabel: 'Not now' }); expect(result.status).toBe(202); expect(await result.json()).toMatchObject({ closed: false, repeated: false });
  expect((await f.app.projectHub.decision(decision.id))?.document.answer).toBeUndefined();
  await expect(f.app.projectWork.decisions.answerChat('project', decision.id, { clientRequestId: 'agent_approval', optionLabel: 'Deploy aaaaaaa' }, 'Approve it')).rejects.toThrow('owner’s deploy message');
});
