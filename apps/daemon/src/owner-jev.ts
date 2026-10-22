import { placementPromptText, mergePromptText, parsePlacementPrompt, parseMergePrompt } from '@jevellan/decisions';
import { AccountSchema, EffortSchema, JevLessonSchema, JevPromptVersionSchema, JevProposalSchema, JevRuleSchema, LandingCorrectionSchema, LandingRouteSchema, MergeCorrectionSchema, unifiedDiff,
  type JevLesson, type JevPromptVersion, type JevProposal, type JevRule, type LandingRoute, type Thread } from '@jevellan/core';
import { LANDING_CRITERIA, LANDING_INSTRUCTIONS, applyJevEffortRules, decideLandingRoute, type LandingPrompt } from '@jevellan/decisions';
import type { LandingJev } from '@jevellan/projects';
import type { Application } from './application.js';
import { OwnerRefusal } from './owner-tools.js';

const RULES = 'owner-jev-rules', PROMPTS = 'owner-jev-prompts', PROPOSALS = 'owner-jev-proposals', LESSONS = 'owner-jev-lessons', MIGRATED = 'owner-jev-migrated';
const ID_SPACE = 'jev';
const ROUTES = ['land', 'verify-then-land', 'ask-owner'] as const;
type Route = typeof ROUTES[number];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** l-v1 as text the owner edits: the instructions, then one `route: criterion` line per route. */
export function landingPromptText(prompt: LandingPrompt): string { return [prompt.instructions, ...ROUTES.map(route => `${route}: ${prompt.criteria[route]}`)].join('\n'); }
export function parseLandingPrompt(text: string): LandingPrompt {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean); const criteria: Partial<Record<Route, string>> = {}; const instructions: string[] = [];
  for (const line of lines) { const route = ROUTES.find(name => line.startsWith(`${name}:`)); if (route) criteria[route] = line.slice(route.length + 1).trim(); else if (!Object.keys(criteria).length) instructions.push(line); }
  if (!instructions.length || ROUTES.some(route => !criteria[route])) throw new OwnerRefusal('An l-v1 prompt needs its instructions first, then one line each for land:, verify-then-land: and ask-owner:.', 'invalid_prompt');
  return { instructions: instructions.join(' '), criteria: criteria as Record<Route, string> };
}
function validatePrompt(name: string, text: string): void {
  if (name === 'l-v1') { parseLandingPrompt(text); return; }
  try { if (name === 'p-v1') parsePlacementPrompt(text); else if (name === 'm-v1') parseMergePrompt(text); }
  catch { throw new OwnerRefusal(`The ${name} prompt must retain its named instructions and criteria.`, 'invalid_prompt'); }
}
/** The prompts and question sets Jev uses, as the code defines them (imported as version 1). All three are read back by their engine services. */
function codeDefaults(): Array<{ name: string; text: string; wired: boolean }> {
  return [{ name: 'l-v1', text: landingPromptText({ instructions: LANDING_INSTRUCTIONS, criteria: LANDING_CRITERIA }), wired: true },
    { name: 'p-v1', text: placementPromptText(), wired: true },
    { name: 'm-v1', text: mergePromptText(), wired: true }];
}
const keyOf = (name: string, version: number) => `${name.replace(/[^A-Za-z0-9]/gu, '_')}_v${version}`;

/**
 * Jev control on the state point (bridge specification, "Jev control"): structured rules applied after Jev's answer, versioned prompts
 * with proposals replayed against real past decisions, and lessons from the owner's overrides that reach Jev as a section of its input.
 */
export class OwnerJev {
  constructor(private readonly app: Application, readonly now: () => Date = () => new Date()) {}
  #id(prefix: 'R' | 'L' | 'P', key: string): string { return this.app.ownerTools.ids.one(ID_SPACE, prefix, key); }
  #put<T>(namespace: string, key: string, schema: { parse(value: unknown): T }, document: T): T {
    const stored = this.app.hub.get(namespace, key, schema as never) as { revision: number } | null;
    return this.app.hub.put(namespace, key, schema as never, document, stored?.revision ?? 0).document as T;
  }

  // Prompts.
  versions(name?: string): JevPromptVersion[] {
    this.#import();
    return this.app.hub.list(PROMPTS, JevPromptVersionSchema).map(row => row.document).filter(row => !name || row.name === name).sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }
  active(name: string): JevPromptVersion { const found = this.versions(name).find(row => row.active); if (!found) throw new OwnerRefusal(`There is no prompt ${name}. Prompts: ${[...new Set(this.versions().map(row => row.name))].join(', ')}.`, 'prompt_not_found', 404); return found; }
  #import(): void {
    for (const entry of codeDefaults()) {
      const rows = this.app.hub.list(PROMPTS, JevPromptVersionSchema).map(row => row.document).filter(row => row.name === entry.name);
      if (!rows.length) { this.#put(PROMPTS, keyOf(entry.name, 1), JevPromptVersionSchema, { schema: 'jev-prompt-version-v1', key: keyOf(entry.name, 1), name: entry.name, version: 1, text: entry.text, summary: 'Imported from the code.', createdAt: this.now().toISOString(), active: true, source: 'code' }); continue; }
      // A later release changed the code default: it becomes a proposal, never active on its own.
      const known = rows.some(row => row.text === entry.text) || this.proposals().some(row => row.name === entry.name && row.text === entry.text);
      if (!known) this.#propose('installation', entry.name, entry.text, 'New default from code.', 'code');
    }
  }
  proposals(): JevProposal[] { return this.app.hub.list(PROPOSALS, JevProposalSchema).map(row => row.document).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  #propose(projectId: string, name: string, text: string, summary: string, source: 'owner' | 'code'): JevProposal {
    const current = this.app.hub.list(PROMPTS, JevPromptVersionSchema).map(row => row.document).find(row => row.name === name && row.active);
    const key = `proposal_${name.replace(/[^A-Za-z0-9]/gu, '_')}_${this.app.hub.list(PROPOSALS, JevProposalSchema).length + 1}`;
    return this.#put(PROPOSALS, key, JevProposalSchema, { schema: 'jev-prompt-proposal-v1', key, id: this.#id('P', key), projectId: projectId === 'installation' ? ID_SPACE : projectId, name, fromVersion: current?.version ?? 1, text, summary, source, createdAt: this.now().toISOString(), state: 'proposed' });
  }
  async propose(projectId: string, name: string, input: { text?: string; edits?: Array<{ find: string; replace: string }>; summary: string }): Promise<string> {
    const current = this.active(name); let text = input.text ?? current.text;
    if (input.edits) input.edits.forEach((edit, index) => {
      const count = text.split(edit.find).length - 1;
      if (count !== 1) throw new OwnerRefusal(`Edit ${index + 1} did not match the current prompt text exactly once.`, 'edit_mismatch');
      text = text.replace(edit.find, edit.replace);
    });
    if (!input.text && !input.edits) throw new OwnerRefusal('prompt_propose takes the full text or edits.', 'invalid_arguments');
    validatePrompt(name, text);
    if (text === current.text) throw new OwnerRefusal('The proposal is the same as the live version.', 'no_change');
    const proposal = this.#propose(projectId, name, text, input.summary, 'owner');
    const replay = await this.replayText(projectId, proposal, 20);
    this.#put(PROPOSALS, proposal.key, JevProposalSchema, { ...proposal, replay });
    const diff = unifiedDiff(name, current.text, text).slice(0, 3000);
    return `${proposal.id} for ${name} (v${current.version} to v${current.version + 1}): ${input.summary}\nDiff:\n${diff}\n${replay}\nNot applied yet.`;
  }
  apply(proposalId: string): string {
    const proposal = this.proposals().find(row => row.id === proposalId.toUpperCase());
    if (!proposal || proposal.state !== 'proposed') throw new OwnerRefusal(`${proposalId} is not an open proposal.`, 'proposal_not_open', 409);
    validatePrompt(proposal.name, proposal.text);
    const versions = this.versions(proposal.name); const current = versions.find(row => row.active)!; const next = Math.max(...versions.map(row => row.version)) + 1;
    for (const row of versions.filter(entry => entry.active)) this.#put(PROMPTS, row.key, JevPromptVersionSchema, { ...row, active: false });
    this.#put(PROMPTS, keyOf(proposal.name, next), JevPromptVersionSchema, { schema: 'jev-prompt-version-v1', key: keyOf(proposal.name, next), name: proposal.name, version: next, text: proposal.text, summary: proposal.summary,
      createdAt: this.now().toISOString(), active: true, source: proposal.source, ...(proposal.replay ? { replay: proposal.replay.slice(0, 4000) } : {}) });
    this.#put(PROPOSALS, proposal.key, JevProposalSchema, { ...proposal, state: 'applied' });
    return `${proposal.name} v${next} is live. The previous version was v${current.version}.`;
  }
  rollback(name: string, version: number): string {
    const versions = this.versions(name); const target = versions.find(row => row.version === version); const current = versions.find(row => row.active);
    if (!target) throw new OwnerRefusal(`${name} has versions ${versions.map(row => `v${row.version}`).join(', ')}.`, 'version_not_found', 404);
    validatePrompt(name, target.text);
    if (target.active) return `${name} v${version} is already live.`;
    for (const row of versions.filter(entry => entry.active)) this.#put(PROMPTS, row.key, JevPromptVersionSchema, { ...row, active: false });
    this.#put(PROMPTS, target.key, JevPromptVersionSchema, { ...target, active: true });
    return `${name} v${version} is live again. v${current?.version ?? '?'} stays in the history.`;
  }

  // Rules.
  rules(projectId: string): JevRule[] { return this.app.hub.list(RULES, JevRuleSchema).map(row => row.document).filter(rule => rule.scope === 'global' || rule.projectId === projectId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))); }
  async saveRule(projectId: string, input: { rule?: string; scope?: 'global' | 'project'; when?: JevRule['when']; set?: Partial<JevRule['set']>; note?: string; enabled?: boolean }): Promise<JevRule> {
    const configuration = (await this.app.configuration()).configuration['x-jevellan'];
    const existing = input.rule ? this.rules(projectId).find(rule => rule.id === input.rule!.toUpperCase()) : undefined;
    if (input.rule && !existing) throw new OwnerRefusal(`${input.rule} is not a rule. Rules: ${this.rules(projectId).map(rule => rule.id).join(', ') || 'none'}.`, 'rule_not_found', 404);
    const set = { ...existing?.set, ...input.set } as JevRule['set'];
    if (!existing && !Object.keys(set).length) throw new OwnerRefusal('rule_set needs something to set: minModel, minEffort, maxEffort, account, runtime or landingRoute.', 'invalid_rule');
    if (set.minEffort && set.maxEffort && EFFORTS.indexOf(set.minEffort) > EFFORTS.indexOf(set.maxEffort)) throw new OwnerRefusal('minEffort must not exceed maxEffort.', 'invalid_rule');
    const accounts = this.app.hub.list('accounts', AccountSchema).map(row => row.document);
    if (set.account) {
      const matches = accounts.filter(account => account.id === set.account || account.label.toLowerCase() === set.account!.toLowerCase());
      if (matches.length !== 1) throw new OwnerRefusal('The rule account must identify one existing account.', 'invalid_rule');
      set.account = matches[0]!.id;
    }
    if (set.runtime && (!this.app.runtimes.has(set.runtime) || !accounts.some(account => account.runtime === set.runtime))) throw new OwnerRefusal('The rule runtime must be installed and have an account.', 'invalid_rule');
    if (set.minModel) {
      const matches = configuration.menu.filter(model => model.id === set.minModel || model.label.toLowerCase() === set.minModel!.toLowerCase());
      if (matches.length !== 1 || !accounts.some(account => account.runtime === matches[0]!.runtime)) throw new OwnerRefusal('The rule model must identify one configured model whose provider has an account.', 'invalid_rule');
      set.minModel = matches[0]!.id;
    }
    const key = existing?.key ?? `rule_${this.app.hub.list(RULES, JevRuleSchema).length + 1}_${Date.now().toString(36)}`;
    return this.#put(RULES, key, JevRuleSchema, JevRuleSchema.parse({ schema: 'jev-rule-v1', key, id: existing?.id ?? this.#id('R', key), scope: input.scope ?? existing?.scope ?? 'project', ...((input.scope ?? existing?.scope ?? 'project') === 'project' ? { projectId } : {}),
      when: { ...existing?.when, ...input.when }, set, note: input.note ?? existing?.note ?? '', enabled: input.enabled ?? existing?.enabled ?? true, createdAt: existing?.createdAt ?? this.now().toISOString() }));
  }
  removeRule(projectId: string, id: string): JevRule {
    const rule = this.rules(projectId).find(row => row.id === id.toUpperCase()); if (!rule) throw new OwnerRefusal(`${id} is not a rule.`, 'rule_not_found', 404);
    this.app.hub.delete(RULES, rule.key); return rule;
  }
  #matches(rule: JevRule, context: { taskType?: string | undefined; goalId?: string | null; label?: string; text: string }): number {
    if (!rule.enabled) return -1; let fields = 0;
    if (rule.when.taskType) { if (rule.when.taskType !== context.taskType) return -1; fields++; }
    if (rule.when.goalId) { if (rule.when.goalId !== context.goalId) return -1; fields++; }
    if (rule.when.label) { if (rule.when.label.toLowerCase() !== (context.label ?? '').toLowerCase()) return -1; fields++; }
    if (rule.when.keywords?.length) { if (!rule.when.keywords.some(word => context.text.toLowerCase().includes(word.toLowerCase()))) return -1; fields++; }
    return fields;
  }
  /** The landing route after the owner's rules: project scope beats global, more `when` fields beat fewer, then the more careful route. */
  ruleRoute(projectId: string, route: Route, context: { taskType?: string | undefined; goalId?: string | null; text: string }, rules = this.rules(projectId)): { route: Route; rulesApplied: string[]; reason: string } {
    const ranked = rules.filter(rule => rule.set.landingRoute).map(rule => ({ rule, fields: this.#matches(rule, context) })).filter(row => row.fields >= 0)
      .sort((a, b) => Number(b.rule.scope === 'project') - Number(a.rule.scope === 'project') || b.fields - a.fields || ROUTES.indexOf(b.rule.set.landingRoute!) - ROUTES.indexOf(a.rule.set.landingRoute!));
    const top = ranked[0]; if (!top || top.rule.set.landingRoute === route) return { route, rulesApplied: [], reason: '' };
    return { route: top.rule.set.landingRoute!, rulesApplied: [top.rule.id], reason: `${top.rule.id} changed the landing route from ${route} to ${top.rule.set.landingRoute}${top.rule.note ? ` (${top.rule.note})` : ''}.` };
  }
  /** Effort the owner's rules allow for a placement (used to measure a rule change on past placements). */
  ruleEffort(projectId: string, effort: string, context: { taskType?: string | undefined; goalId?: string | null; text: string }, rules = this.rules(projectId)): { effort: string; rule?: string } {
    const parsed = EffortSchema.safeParse(effort); if (!parsed.success) return { effort };
    const result = applyJevEffortRules(projectId, parsed.data, rules, context);
    return { effort: result.effort, ...(result.rulesApplied[0] ? { rule: result.rulesApplied[0] } : {}) };
  }
  /** What a rule set would have changed on the last 30 decisions, with no model calls: rules re-applied to the stored raw choices. */
  async ruleEffect(projectId: string, rules = this.rules(projectId)): Promise<string> {
    const routes = (await this.#routes(projectId)).slice(0, 30); const threads = (await this.app.projectWork.view(projectId)).threads;
    const changes: string[] = [];
    for (const route of routes) {
      const raw = route.rawChoice ?? route.route; const thread = threads.find(row => row.id === route.threadId);
      const result = this.ruleRoute(projectId, raw, { taskType: route.packet.task.type, text: `${route.packet.title} ${route.packet.summary}` }, rules);
      if (result.route !== route.route && route.source === 'jev') changes.push(`${this.app.ownerTools.ids.one(projectId, 'D', route.id)} ${thread ? this.app.ownerTools.ids.shortOf(projectId, thread.id) ?? '' : ''} ${route.route} to ${result.route}`.replace(/  +/gu, ' '));
    }
    for (const thread of threads.slice(-Math.max(0, 30 - routes.length))) {
      const result = this.ruleEffort(projectId, thread.effort, { text: thread.title }, rules);
      if (result.effort !== thread.effort) changes.push(`${this.app.ownerTools.ids.one(projectId, 'D', `placement-${thread.id}`.slice(0, 128))} ${this.app.ownerTools.ids.shortOf(projectId, thread.id) ?? ''} ${thread.effort} to ${result.effort}`.replace(/  +/gu, ' '));
    }
    return `On the last 30 decisions it would have changed ${changes.length}${changes.length ? `: ${changes.join(', ')}` : ''}.`;
  }
  async #routes(projectId: string): Promise<LandingRoute[]> {
    const rows = await this.app.projectWork.landings.records(projectId);
    return rows.filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
  }

  // Lessons.
  lessons(projectId: string): JevLesson[] {
    this.#migrate(projectId);
    return this.app.hub.list(LESSONS, JevLessonSchema).map(row => row.document).filter(row => row.scope === 'global' || row.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  addLesson(projectId: string, input: { text: string; about: JevLesson['about']; source: string }): JevLesson {
    const key = `lesson_${this.app.hub.list(LESSONS, JevLessonSchema).length + 1}_${Date.now().toString(36)}`;
    return this.#put(LESSONS, key, JevLessonSchema, JevLessonSchema.parse({ schema: 'jev-lesson-v1', key, id: this.#id('L', key), scope: 'project', projectId, about: input.about, text: input.text.slice(0, 1000), source: input.source, enabled: true, timesApplied: 0, createdAt: this.now().toISOString() }));
  }
  editLesson(projectId: string, id: string, change: { text?: string; enabled?: boolean } | 'remove'): JevLesson {
    const lesson = this.lessons(projectId).find(row => row.id === id.toUpperCase()); if (!lesson) throw new OwnerRefusal(`${id} is not a lesson.`, 'lesson_not_found', 404);
    if (change === 'remove') { this.app.hub.delete(LESSONS, lesson.key); return lesson; }
    return this.#put(LESSONS, lesson.key, JevLessonSchema, { ...lesson, ...(change.text ? { text: change.text } : {}), ...(change.enabled !== undefined ? { enabled: change.enabled } : {}) });
  }
  /** The owner's landing and merge corrections become lessons once, so there is one place for what Jev learned. */
  #migrate(projectId: string): void {
    if (this.app.hub.get(MIGRATED, projectId, JevLessonSchema as never)) return;
    void this.app.projectWork.landings.records(projectId).then(rows => {
      if (this.app.hub.get(MIGRATED, projectId, JevLessonSchema as never)) return;
      for (const row of rows) {
        const parsed = row.schema === 'landing-correction-v1' ? LandingCorrectionSchema.safeParse(row) : row.schema === 'merge-correction-v1' ? MergeCorrectionSchema.safeParse(row) : null;
        if (!parsed?.success) continue; const correction = parsed.data as { title: string; correction: string };
        this.addLesson(projectId, { about: 'landing', source: 'migrated', text: `For "${correction.title}", the owner said: ${correction.correction === 'should-have-asked' ? 'Should have asked me' : "Didn't need asking"}.` });
      }
      this.app.hub.put(MIGRATED, projectId, JevLessonSchema as never, JevLessonSchema.parse({ schema: 'jev-lesson-v1', key: 'migrated', id: 'L1', scope: 'project', projectId, about: 'other', text: 'Landing corrections migrated.', source: 'migrated', enabled: false, timesApplied: 0, createdAt: this.now().toISOString() }), 0);
    }).catch(() => undefined);
  }

  /** The hook the landing service calls before asking Jev l-v1. */
  async landingHook(projectId: string): Promise<LandingJev> {
    const version = this.active('l-v1'); const prompt = parseLandingPrompt(version.text);
    const lessons = this.lessons(projectId).filter(row => row.enabled && row.about === 'landing').slice(0, 30);
    for (const lesson of lessons.slice(0, 8)) this.#put(LESSONS, lesson.key, JevLessonSchema, { ...lesson, timesApplied: lesson.timesApplied + 1 });
    return { version: version.version, prompt, lessons: { ids: lessons.slice(0, 8).map(row => row.id), texts: lessons.slice(0, 8).map(row => row.text) },
      apply: (route, thread: Thread) => this.ruleRoute(projectId, route, { ...(thread.taskContext?.type ? { taskType: thread.taskContext.type } : {}), text: `${thread.title} ${thread.task.slice(0, 2000)}` }) };
  }

  /** Re-asks Jev with each stored packet and the proposed prompt or lessons, applies the current rules and compares with what happened. */
  async replayText(projectId: string, proposal: JevProposal | null, n: number, lessonId?: string): Promise<string> {
    const routes = (await this.#routes(projectId)).filter(row => row.source === 'jev' || row.rawChoice).slice(0, n);
    const skipped = (await this.#routes(projectId)).length - routes.length;
    if (proposal && proposal.name !== 'l-v1') return `Replay is available for l-v1 only in this version; ${proposal.name} is versioned but not yet read by the engine.`;
    const prompt = proposal ? parseLandingPrompt(proposal.text) : parseLandingPrompt(this.active('l-v1').text);
    const lessons = this.lessons(projectId).filter(row => row.enabled && row.about === 'landing' && (!lessonId || true)).slice(0, 8).map(row => row.text);
    const changed: string[] = []; const model = (await this.app.configuration()).configuration['x-jevellan'].decisions.model;
    for (const route of routes) {
      const result = await decideLandingRoute(this.app.decisionClient, { ...route.packet, corrections: lessons }, model, this.app.redactor, new AbortController().signal, prompt);
      const final = result.source === 'jev' ? this.ruleRoute(projectId, result.route, { taskType: route.packet.task.type, text: `${route.packet.title} ${route.packet.summary}` }).route : result.route;
      if (final !== route.route) changed.push(`${this.app.ownerTools.ids.one(projectId, 'D', route.id)} ${this.app.ownerTools.ids.shortOf(projectId, route.threadId) ?? ''} ${route.route} to ${final}`.replace(/  +/gu, ' '));
    }
    return [`Replay on the last ${routes.length} decisions that used l-v1: ${changed.length} would change.`, ...changed,
      'Estimated cost of the changed runs: model changes only, from recorded usage and current prices; none in this replay.', ...(skipped ? [`Skipped ${skipped} older decisions without stored inputs.`] : [])].join('\n');
  }
}
export { LandingRouteSchema };
