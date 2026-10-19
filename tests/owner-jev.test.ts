import { afterEach, expect, test } from 'vitest';
import { LandingRouteSchema } from '../packages/core/dist/index.js';
import { FakeRuntime, forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
import { ATTACH_MENU, claudeAccount, named, rest, start } from './helpers/attach-cli.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const text = async (name: string, args: Record<string, unknown>) => { const result = await f!.app.ownerTools.call(name, { schema: 'owner-tool-request-v1', caller: 'bridge:project', args }); return result.ok ? result.text : `ERROR ${result.error.code}: ${result.error.text}`; };
const route = (id: string, raw: 'land' | 'verify-then-land' | 'ask-owner', title: string, threadId: string) => LandingRouteSchema.parse({ schema: 'landing-route-v1', id, projectId: 'project', revision: 0, deviceId: f!.app.device.deviceId, threadId,
  commit: 'a'.repeat(40), at: new Date().toISOString(), questionSet: 'l-v1', route: raw, rawChoice: raw, source: 'jev', reason: 'Jev chose.', calls: [], state: 'landed',
  packet: { schema: 'landing-route-state-v1', title, task: { type: 'feature', needs: [], goal: null }, summary: `${title}.`, riskyAreas: '', files: [], checks: [], corrections: [] } });

test('rules are saved with their effect on past decisions, prompts are versioned through proposals, and lessons are listed', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  f = await projectFixture({ control: true, menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude } });
  await claudeAccount(f);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Half.' }), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture'); await rest(f, threadId);
  await f.app.projectHub.putMergeDocument(route('lroute_one', 'land', 'Change the parser rounding', threadId), 0);
  await f.app.projectHub.putMergeDocument(route('lroute_two', 'land', 'Update the docs', threadId), 0);
  expect(await text('jev', { action: 'rules' })).toBe(`Jev rules for ${f.project.name} (global and project)\nnone`);
  const saved = await text('jev', { action: 'rule_set', when: { keywords: ['parser'] }, set: { landingRoute: 'ask-owner' }, note: 'Parser work needs my eyes' });
  expect(saved).toMatch(/^Saved R1: project · keywords parser · landing route ask-owner · "Parser work needs my eyes"\. Applies to new decisions from now on\.\nOn the last 30 decisions it would have changed 1: D\d+ T1 land to ask-owner\.$/u);
  expect(await text('jev', { action: 'rule_set', set: { minEffort: 'max', maxEffort: 'low' } })).toBe('ERROR invalid_rule: minEffort must not exceed maxEffort.');
  expect(await text("jev", { action: "prompts" })).toMatch(/^l-v1 v1 live · 1 version\nm-v1 v1 live · 1 version · versioned; the engine still reads the code text\np-v1 v1 live/u);
  expect(await text('jev', { action: 'prompt_show', name: 'l-v1' })).toContain('land: Small or low-risk change');
  expect(await text('jev', { action: 'prompt_propose', name: 'l-v1', edits: [{ find: 'nothing here', replace: 'x' }], summary: 'No-op' })).toBe('ERROR edit_mismatch: Edit 1 did not match the current prompt text exactly once.');
  const proposed = await text('jev', { action: 'prompt_propose', name: 'l-v1', edits: [{ find: 'Small or low-risk change', replace: 'Small, test-covered change' }], summary: 'Land only covered changes' });
  expect(proposed).toMatch(/^P1 for l-v1 \(v1 to v2\): Land only covered changes\nDiff:\n[\s\S]*Small, test-covered change[\s\S]*Replay on the last 2 decisions that used l-v1: \d would change\.[\s\S]*Not applied yet\.$/u);
  expect(await text('jev', { action: 'prompt_apply', proposal: 'P1' })).toBe('l-v1 v2 is live. The previous version was v1.');
  expect((await f.app.ownerJev.landingHook('project')).prompt.criteria.land).toBe("Small, test-covered change outside the project's risky areas, covered by the checks that passed.");
  expect(await text('jev', { action: 'prompt_rollback', name: 'l-v1', version: 1 })).toBe('l-v1 v1 is live again. v2 stays in the history.');
  expect(await text('jev', { action: 'prompt_history', name: 'l-v1' })).toMatch(/^v1 \(live\) .* · Imported from the code\.\nv2 .* · Land only covered changes/u);
  const hook = await f.app.ownerJev.landingHook('project');
  expect(hook.apply('land', { title: 'Parser fix', task: 'Fix the parser.', taskContext: { type: 'fix', needs: [], goal: null } } as never)).toEqual({ route: 'ask-owner', rulesApplied: ['R1'], reason: 'R1 changed the landing route from land to ask-owner (Parser work needs my eyes).' });
  expect(await text('jev', { action: 'rule_remove', rule: 'R1' })).toMatch(/^Removed R1\.\nOn the last 30 decisions it would have changed 0\.$/u);
});

test('override only records a lesson the jev tool lists; override with undo restarts a placement', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  f = await projectFixture({ control: true, menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude } });
  await claudeAccount(f);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Half.' }), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture'); await rest(f, threadId);
  const decisions = await text('activity', { kind: 'decisions', target: 'all' });
  const d = decisions.match(/(D\d+) .* Jev · T1 on /u)![1]!;
  expect(await text('override', { decision: d, choice: 'high', mode: 'override_only', reason: 'Renames do not need high effort' })).toBe(`Recorded override of ${d}. Nothing was changed. Lesson L1 recorded for ${f.project.name}: "Renames do not need high effort".`);
  expect(await text('jev', { action: 'lessons' })).toBe(`L1 project · applied 0 times · "Renames do not need high effort" (from override of ${d})`);
  expect(await text('jev', { action: 'lesson_edit', lesson: 'L1', enabled: false })).toBe('Updated L1: disabled.');
  expect(await text('override', { decision: 'D99', choice: 'high', mode: 'override_only', reason: 'x' })).toBe('ERROR not_found: D99 is not a decision. See decisions with activity kind decisions.');
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Again.' }), forThread());
  expect(await text('override', { decision: d, choice: 'claude_fixture', mode: 'override_undo', reason: 'Use the fixture model' })).toMatch(new RegExp(`^Overrode ${d}: T1 restarts on claude_fixture from the commit at \\d\\d:\\d\\d\\. Work after that point is discarded\\. Lesson L2 recorded`, 'u'));
});
