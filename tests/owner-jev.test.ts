import { afterEach, expect, test } from 'vitest';
import { LandingRouteSchema, readDocument, JevReplayReportSchema } from '../packages/core/dist/index.js';
import { FakeRuntime, forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
import { ATTACH_MENU, claudeAccount, named, rest, start } from './helpers/attach-cli.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const text = async (name: string, args: Record<string, unknown>) => { const result = await f!.app.ownerTools.call(name, { schema: 'owner-tool-request-v1', caller: 'bridge:project', args }); return result.ok ? result.text : `ERROR ${result.error.code}: ${result.error.text}`; };
const route = (id: string, raw: 'land' | 'verify-then-land' | 'ask-owner', title: string, threadId: string) => {
  const packet = { schema: 'landing-route-state-v1', title, task: { type: 'feature', needs: [], goal: null }, summary: `${title}.`, riskyAreas: '', files: [], checks: [], corrections: [] };
  return LandingRouteSchema.parse({ schema: 'landing-route-v1', id, projectId: 'project', revision: 0, deviceId: f!.app.device.deviceId, threadId,
    commit: 'a'.repeat(40), at: new Date().toISOString(), questionSet: 'l-v1', route: raw, rawChoice: raw, source: 'jev', reason: 'Jev chose.', calls: [], state: 'landed',
    packet, inputPacket: packet, inputsRef: id, ruleContext: { schema: 'placement-rule-context-v1', taskType: 'feature', label: 'manual', text: `${title} ${title}.`, complete: true } });
};

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
  expect(await text("jev", { action: "prompts" })).toMatch(/^l-v1 v1 live · 1 version\nm-v1 v1 live · 1 version\np-v1 v1 live/u);
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


test('ROUTECTL historical route rules use the original full task and disclose missing context', async () => {
  f = await projectFixture();
  f.fake.enqueueTurn(reportStep({status:'progress',summary:'Owned history fixture.'}), forThread());
  const started = await f.app.projectWork.createThread('project',{schema:'thread-create-request-v1',clientRequestId:'route_context',title:'History fixture',task:'Preserve this work.',modelId:'fixture',deviceId:f.app.device.deviceId});
  await f.app.projectWork.idle();
  const base = route('lroute_context', 'land', 'Ordinary title', started.threadId);
  await f.app.projectHub.putMergeDocument({ ...base, ruleContext: { schema: 'placement-rule-context-v1', taskType: 'feature', text: 'The original task concerns the parser.', complete: true } }, 0);
  const missing = route('lroute_missing_context', 'land', 'Parser title', started.threadId);
  const {ruleContext: _context, ...legacy} = missing; void _context;
  await f.app.projectHub.putMergeDocument(legacy, 0);
  await f.app.ownerJev.saveRule('project', {when: {keywords: ['parser']}, set: {landingRoute: 'ask-owner'}});
  const result = await f.app.ownerJev.ruleEffect('project');
  expect(result).toContain(`would have changed 1: ${f.app.ownerTools.ids.one('project','D',base.id)} land to ask-owner.`);
  expect(result).toContain('Unavailable original condition contexts: 1.');
});

test('ROUTECTL replay skips legacy packets and retains a recorded hard guard', async () => {
  f = await projectFixture({jevKey: true,decisionFetch:async (_url,init)=>init?.method==='POST'?Response.json({model:'fixture',usage:{input_tokens:1,output_tokens:1},answers:{landing_route:{type:'choice',choice:'land',confidence:1,probabilities:{land:1,'verify-then-land':0,'ask-owner':0}}}}):Response.json({models:[]})});
  f.fake.enqueueTurn(reportStep({status:'progress',summary:'Owned replay fixture.'}), forThread());
  const started = await f.app.projectWork.createThread('project',{schema:'thread-create-request-v1',clientRequestId:'route_replay',title:'Replay fixture',task:'Preserve this work.',modelId:'fixture',deviceId:f.app.device.deviceId});
  await f.app.projectWork.idle();
  const base = route('lroute_legacy', 'land', 'Legacy work', started.threadId);
  const {inputPacket: _packet, ...legacy} = base; void _packet;
  await f.app.projectHub.putMergeDocument(legacy, 0);
  const guard = route('lroute_guard', 'ask-owner', 'Guarded work', started.threadId);
  await f.app.projectHub.putMergeDocument({...guard,source: 'guard',rawChoice: 'land', calls: [{schema:'jev-call-v1',kind:'landing',requestedModel:'fixture',returnedModel:'fixture',usage:{input_tokens:1,output_tokens:1},latencyMs:1}]}, 0);
  const result = await f.app.ownerJev.propose('project', 'l-v1', {edits: [{find:'Small or low-risk change',replace:'Small covered change'}],summary:'Guard replay.'});
  const proposal = f.app.ownerJev.proposals().find(row => row.id === result.match(/^P[1-9][0-9]*/u)![0])!;
  const summary = f.app.ownerJev.replayReport('project', proposal.replayReportId!);
  expect(summary).toMatchObject({selected:1,compared:1,changed:0,legacySkipped:1});
  const report = readDocument(f.app.homes.at('jev-replays','project',`${summary.id}.json`), JevReplayReportSchema);
  expect(report.entries[0]).toMatchObject({originalChoice:'ask-owner',finalChoice:'ask-owner',reason:'The recorded hard-guard refusal is retained.'});
  expect(f.fake.runs).toHaveLength(1);
});
