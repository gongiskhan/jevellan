import {projectJevLessons} from '@jevellan/decisions';
import {applyJevRouteRules,landingPromptText as formatLandingPrompt,parseLandingPrompt as parseEngineLandingPrompt} from '@jevellan/decisions';
import {applyHistoricalRules,choiceLabel,choiceOf,currentThreadFacts,newest,placementHistory,sameChoice} from './owner-jev-history.js';
import {replayPlacement,replayRoutes,replaySummary} from './owner-jev-replay.js';
import { placementPromptText, mergePromptText, parsePlacementPrompt, parseMergePrompt } from '@jevellan/decisions';
import { AccountSchema, EffortSchema, JevLessonSchema, JevPromptVersionSchema, JevProposalSchema, JevRuleSchema, LandingRouteSchema, unifiedDiff,
  type JevLesson, type JevPromptVersion, type JevProposal, type JevRule, type LandingRoute, type Thread, type MergeDocument } from '@jevellan/core';
import { LANDING_CRITERIA, LANDING_INSTRUCTIONS, applyJevEffortRules, decideLandingRoute, type LandingPrompt } from '@jevellan/decisions';
import type { LandingJev } from '@jevellan/projects';
import type { Application } from './application.js';
import { OwnerRefusal } from './owner-tools.js';

const RULES = 'owner-jev-rules', PROMPTS = 'owner-jev-prompts', PROPOSALS = 'owner-jev-proposals', LESSONS = 'owner-jev-lessons', MIGRATED = 'owner-jev-migrated';
const ID_SPACE = 'jev';
type Route = keyof LandingPrompt['criteria'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** l-v1 as text the owner edits: the instructions, then one `route: criterion` line per route. */
export const landingPromptText=formatLandingPrompt;
export function parseLandingPrompt(text:string):LandingPrompt{try{return parseEngineLandingPrompt(text);}catch{throw new OwnerRefusal('An l-v1 prompt needs its instructions first, then one line each for land:, verify-then-land: and ask-owner:.','invalid_prompt');}}
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
  readonly #migrations=new Map<string,Promise<void>>();
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
    const latest = this.proposals().find(row => row.key === proposal.key)!;
    this.#put(PROPOSALS, proposal.key, JevProposalSchema, { ...latest, replay });
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
      createdAt: this.now().toISOString(), active: true, source: proposal.source, ...(proposal.replay ? { replay: proposal.replay.slice(0, 4000) } : {}), ...(proposal.replayReportId ? { replayReportId: proposal.replayReportId } : {}) });
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
  /** The same scope/specificity/careful-floor policy used by every project route. */
  ruleRoute(projectId:string,route:Route,context:import('@jevellan/decisions').JevRuleContext,rules=this.rules(projectId)){return applyJevRouteRules(projectId,route,rules,context);}
  /** Effort the owner's rules allow for a placement (used to measure a rule change on past placements). */
  ruleEffort(projectId: string, effort: string, context: { taskType?: string | undefined; goalId?: string | null | undefined; label?: string; text: string }, rules = this.rules(projectId)): { effort: string; rule?: string } {
    const parsed = EffortSchema.safeParse(effort); if (!parsed.success) return { effort };
    const result = applyJevEffortRules(projectId, parsed.data, rules, context);
    return { effort: result.effort, ...(result.rulesApplied[0] ? { rule: result.rulesApplied[0] } : {}) };
  }
  /** What a rule set would have changed on the last 30 decisions, with no model calls: rules re-applied to the stored raw choices. */
  async ruleEffect(projectId: string, rules = this.rules(projectId)): Promise<string> {
    const [history, current, documents] = await Promise.all([placementHistory(this.app, projectId, 30), currentThreadFacts(this.app, projectId), this.app.projectWork.landings.records(projectId)]);
    const routes = documents.filter(row => row.schema === 'landing-route-v1' || row.schema === 'merge-route-v1');
    const sources = newest([...history.records.map(record => ({ kind: 'placement' as const, id: record.id, at: record.at, record })),
      ...routes.map(record => ({ kind: 'route' as const, id: record.id, at: record.at, record }))]).slice(0, 30);
    const changes: string[] = []; let missingContext = 0;
    for (const source of sources) {
      if (source.kind === 'placement') {
        const row = source.record, result = applyHistoricalRules(row, rules);
        if (!result) { missingContext++; continue; }
        const final = result.kind === 'placed' ? choiceOf(result.record) : null;
        if (!sameChoice(row.finalChoice, final)) {
          const threadId = row.threadId ?? current.facts.find(fact => fact.placement.inputsRef === row.id)?.id;
          const d = this.app.ownerTools.ids.one(projectId, 'D', row.id), t = threadId ? this.app.ownerTools.ids.shortOf(projectId, threadId) ?? '' : '';
          changes.push(`${d} ${t} ${choiceLabel(row, row.finalChoice)} to ${choiceLabel(row, final)}${result.kind === 'refused' ? `: ${result.message}` : ''}`.replace(/  +/gu, ' ').slice(0, 400));
        }
      } else {
        const row = source.record;
        // An explicit hard-guard or unavailable result stays closed; rules cannot make it an automatic route.
        if (row.source !== 'jev') continue;
        const raw = row.rawChoice ?? row.route, landing = raw === 'merge' ? 'land' : raw === 'test-then-merge' ? 'verify-then-land' : raw;
        const context = row.ruleContext?.complete ? row.ruleContext : rules.some(rule => rule.enabled && Object.keys(rule.when).length) ? null : { text: '' };
        if (!context) { missingContext++; continue; }
        const result = this.ruleRoute(projectId, landing, context, rules);
        const final = row.schema === 'merge-route-v1' ? result.route === 'land' ? 'merge' : result.route === 'verify-then-land' ? 'test-then-merge' : result.route : result.route;
        if (final !== row.route) changes.push(`${this.app.ownerTools.ids.one(projectId, 'D', row.id)} ${this.app.ownerTools.ids.shortOf(projectId, row.threadId) ?? ''} ${row.route} to ${final}`.replace(/  +/gu, ' '));
      }
    }
    const legacy = current.facts.filter(row => row.placement.source !== 'fixed' && !row.placement.inputsRef).length;
    return [`On the last 30 decisions it would have changed ${changes.length}${changes.length ? `: ${changes.join(', ')}` : ''}.`,
      ...(missingContext ? [`Unavailable original condition contexts: ${missingContext}.`] : []), ...(legacy ? [`Skipped ${legacy} older placements without stored inputs.`] : []),
      ...(history.unavailableDevices.length ? [`Unavailable input devices: ${history.unavailableDevices.length}; this result is partial.`] : []),
      ...(history.limitedDevices.length ? [`History read limit reached on ${history.limitedDevices.length} devices; this result is partial.`] : []),
      ...(current.unavailableThreads.length ? [`Unavailable thread owners: ${current.unavailableThreads.length}.`] : [])].join('\n');
  }

  async #routes(projectId: string): Promise<LandingRoute[]> {
    const rows = await this.app.projectWork.landings.records(projectId);
    return rows.filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
  }

  // Lessons.
  lessons(projectId: string): JevLesson[] {
    return this.app.hub.list(LESSONS, JevLessonSchema).map(row => row.document).filter(row => row.scope === 'global' || row.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)||Number(b.id.slice(1))-Number(a.id.slice(1)));
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
  async prepare(projectId:string):Promise<void>{
    if(this.app.hub.get(MIGRATED,projectId,JevLessonSchema))return;
    const prior=this.#migrations.get(projectId);if(prior)return prior;
    const operation=this.#migrate(projectId);this.#migrations.set(projectId,operation);try{await operation;}finally{this.#migrations.delete(projectId);}
  }
  /** New correction receipts enter lessons in the writer's transaction, independently of the legacy migration marker. */
  recordCorrection(row:MergeDocument):void{
    if(row.schema!=='landing-correction-v1'&&row.schema!=='merge-correction-v1')return;
    const key=`migrated_${row.id}`;if(this.app.hub.get(LESSONS,key,JevLessonSchema))return;
    this.#put(LESSONS,key,JevLessonSchema,JevLessonSchema.parse({schema:'jev-lesson-v1',key,id:this.#id('L',key),scope:'project',projectId:row.projectId,about:'landing',text:`For “${row.title}”, the owner said: ${row.correction==='should-have-asked'?'Should have asked me':"Didn't need asking"}.`,source:'migrated',enabled:true,timesApplied:0,createdAt:row.at}));
  }
  async #migrate(projectId:string):Promise<void>{
    const rows=await this.app.projectWork.landings.records(projectId);
    this.app.hub.transaction(()=>{
      if(this.app.hub.get(MIGRATED,projectId,JevLessonSchema))return;
      for(const row of [...rows].sort((a,b)=>a.at.localeCompare(b.at)||(('receivedOrder' in a?a.receivedOrder:0)??0)-(('receivedOrder' in b?b.receivedOrder:0)??0)||a.id.localeCompare(b.id)))this.recordCorrection(row);
      this.app.hub.put(MIGRATED,projectId,JevLessonSchema,JevLessonSchema.parse({schema:'jev-lesson-v1',key:'migrated',id:'L1',scope:'project',projectId,about:'other',text:'Landing corrections migrated.',source:'migrated',enabled:false,timesApplied:0,createdAt:this.now().toISOString()}),0);
    });
  }

  /** The hook the landing service calls before asking Jev l-v1. */
  async landingHook(projectId: string): Promise<LandingJev> {
    await this.prepare(projectId);const version=this.active('l-v1'),prompt=parseLandingPrompt(version.text),lessons=projectJevLessons(projectId,this.lessons(projectId));
    return{version:version.version,prompt,lessons:{ids:lessons.ids,keys:lessons.keys,texts:lessons.corrections.map(row=>row.text),...(lessons.input?{input:lessons.input}:{})},
      apply:(route,thread:Thread)=>this.ruleRoute(projectId,route,{taskType:thread.taskContext?.type??'feature',...(thread.taskContext?.goal?.id?{goalId:thread.taskContext.goal.id}:{}),label:thread.taskContext?.goal?.name??'manual',text:`${thread.title} ${thread.task}`})};
  }

  replayReport(projectId: string, id: string) { return replaySummary(this.app, projectId, id); }

  /** Re-asks Jev with each stored packet and the proposed prompt or lessons, applies the current rules and compares with what happened. */
  async replayText(projectId: string, proposal: JevProposal | null, n: number, lessonId?: string): Promise<string> {
    if (proposal?.name === 'p-v1') {
      const summary = await replayPlacement(this.app, projectId, this.active('p-v1'), proposal, this.rules(projectId), n);
      const latest = this.proposals().find(row => row.key === proposal.key)!;
      this.#put(PROPOSALS, latest.key, JevProposalSchema, { ...latest, replayReportId: summary.id });
      return summary.text;
    }

    if (proposal?.name === 'l-v1' || proposal?.name === 'm-v1') {
      const summary = await replayRoutes(this.app, projectId, proposal.name, this.active(proposal.name), proposal, this.rules(projectId), n);
      const latest = this.proposals().find(row => row.key === proposal.key)!;
      this.#put(PROPOSALS, latest.key, JevProposalSchema, { ...latest, replayReportId: summary.id });
      return summary.text;
    }
    const routes = (await this.#routes(projectId)).filter(row => row.source === 'jev' || row.rawChoice).slice(0, n);
    const skipped = (await this.#routes(projectId)).length - routes.length;
    if (proposal && proposal.name !== 'l-v1') return `Stored-input replay for ${proposal.name} is not available yet; the engine uses its active version.`;
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
