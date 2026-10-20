import { capLines } from '@jevellan/projects';
import { ProjectThreadOverrideEditorSchema, ThreadOverrideViewSchema, ProjectThreadWhyViewSchema, type JevRule } from '@jevellan/core';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { ownerThreadOperation } from '../project-work-api.js';
import { resolveGoal, resolveTask } from './common.js';

function describeRule(rule: JevRule, goals: Map<string, string>): string {
  const when = [rule.when.taskType ? `task type ${rule.when.taskType}` : '', rule.when.goalId ? `goal ${goals.get(rule.when.goalId) ?? rule.when.goalId}` : '', rule.when.label ? `label ${rule.when.label}` : '', rule.when.keywords?.length ? `keywords ${rule.when.keywords.join(', ')}` : ''].filter(Boolean);
  const set = [rule.set.minModel ? `at least ${rule.set.minModel}` : '', rule.set.minEffort ? `at least ${rule.set.minEffort} effort` : '', rule.set.maxEffort ? `at most ${rule.set.maxEffort} effort` : '', rule.set.account ? `account ${rule.set.account}` : '', rule.set.runtime ? `runtime ${rule.set.runtime}` : '', rule.set.landingRoute ? `landing route ${rule.set.landingRoute}` : ''].filter(Boolean);
  return [rule.id, rule.scope, ...(rule.enabled ? [] : ['disabled']), ...(when.length ? when : ['always']), set.join(', '), ...(rule.note ? [`"${rule.note}"`] : [])].join(' · ');
}

/** `jev` (bridge specification, "Jev control"). */
export const jev: OwnerHandler = async (context) => {
  const { app, tools, project, args } = context; const control = app.ownerJev; const projectId = project.id;
  await tools.status(project); // display ids for every current thread and goal
  const goals = new Map((await app.projectWork.goalList(projectId)).goals.map(row => [row.goal.id, tools.ids.one(projectId, 'G', row.goal.id)]));
  switch (context.action) {
    case 'override_editor': case 'override_preview': case 'override_save': {
      const target = await resolveTask(context, String(args.thread));
      if (!target.thread) throw new OwnerRefusal(`${target.id} has no thread yet.`, 'not_running', 409);
      const operation = context.action === 'override_editor' ? 'override-editor' : context.action === 'override_preview' ? 'override-preview' : 'override-save';
      const result = await ownerThreadOperation(app, projectId, target.thread.id, operation, args.request);
      return context.action === 'override_save' ? { text: `Applied override for ${target.id}.`, data: ThreadOverrideViewSchema.parse(result) }
        : { text: `Override ${target.id}.`, data: ProjectThreadOverrideEditorSchema.parse(result) };
    }
    case 'why': {
      const target = await resolveTask(context, String(args.thread));
      if (!target.thread) throw new OwnerRefusal(`${target.id} has no thread yet.`, 'not_running', 409);
      const view = ProjectThreadWhyViewSchema.parse(await ownerThreadOperation(app, projectId, target.thread.id, 'why'));
      return { text: capLines([view.title, `Placement: ${view.placement.sourceLabel}`, view.placement.fixedLine,
        ...view.fields.map(field => `${field.label}: ${field.valueLabel} · ${field.sourceLabel}`), ...(view.placement.fallbackNotice ? [view.placement.fallbackNotice] : []), ...view.jev.lines]), data: view };
    }
    case 'rules': { const rules = control.rules(projectId); return { text: capLines([`Jev rules for ${project.name} (global and project)`, ...(rules.length ? rules.map(rule => describeRule(rule, goals)) : ['none'])]) }; }
    case 'rule_set': {
      const when = (args.when ?? {}) as { taskType?: string; goal?: string; label?: string; keywords?: string[] };
      const goalId = when.goal ? (await resolveGoal(context, when.goal)).goal.id : undefined;
      const rule = control.saveRule(projectId, { ...(typeof args.rule === 'string' ? { rule: args.rule } : {}), ...(args.scope ? { scope: args.scope as 'global' | 'project' } : {}),
        when: { ...(when.taskType ? { taskType: when.taskType } : {}), ...(goalId ? { goalId } : {}), ...(when.label ? { label: when.label } : {}), ...(when.keywords ? { keywords: when.keywords } : {}) },
        ...(args.set ? { set: args.set as JevRule['set'] } : {}), ...(typeof args.note === 'string' ? { note: args.note } : {}), ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}) });
      return { text: `Saved ${describeRule(rule, goals).replace(/^(R\d+) · /u, '$1: ')}. Applies to new decisions from now on.\n${await control.ruleEffect(projectId)}` };
    }
    case 'rule_remove': { const rule = control.removeRule(projectId, String(args.rule)); return { text: `Removed ${rule.id}.\n${await control.ruleEffect(projectId)}` }; }
    case 'prompts': {
      const versions = control.versions(); const names = [...new Set(versions.map(row => row.name))];
      const lines = names.map(name => { const rows = versions.filter(row => row.name === name); const live = rows.find(row => row.active)!; return `${name} v${live.version} live · ${rows.length} version${rows.length === 1 ? '' : 's'}${name === 'l-v1' ? '' : ' · versioned; the engine still reads the code text'}`; });
      for (const proposal of control.proposals().filter(row => row.state === 'proposed')) lines.push(`${proposal.source === 'code' ? 'new default from code' : 'proposed'}: ${proposal.id} for ${proposal.name} (${proposal.summary})`);
      return { text: capLines(lines) };
    }
    case 'prompt_show': {
      const rows = control.versions(String(args.name)); const row = typeof args.version === 'number' ? rows.find(entry => entry.version === args.version) : rows.find(entry => entry.active);
      if (!row) throw new OwnerRefusal(`${String(args.name)} has versions ${rows.map(entry => `v${entry.version}`).join(', ') || 'none'}.`, 'version_not_found', 404);
      return { text: capLines([`${row.name} v${row.version}${row.active ? ' (live)' : ''} · ${row.summary}`, ...row.text.split('\n')], true) };
    }
    case 'prompt_history': {
      const rows = control.versions(String(args.name)); if (!rows.length) throw new OwnerRefusal(`There is no prompt ${String(args.name)}.`, 'prompt_not_found', 404);
      return { text: capLines(rows.map(row => `v${row.version}${row.active ? ' (live)' : ''} ${row.createdAt.slice(0, 10)} · ${row.summary}${row.replay ? ` · ${row.replay.split('\n')[0]}` : ''}`)) };
    }
    case 'prompt_propose': return { text: await control.propose(projectId, String(args.name), { ...(typeof args.text === 'string' ? { text: args.text } : {}), ...(Array.isArray(args.edits) ? { edits: args.edits as Array<{ find: string; replace: string }> } : {}), summary: String(args.summary) }) };
    case 'prompt_apply': return { text: control.apply(String(args.proposal)) };
    case 'prompt_rollback': return { text: control.rollback(String(args.name), Number(args.version)) };
    case 'lessons': {
      const lessons = control.lessons(projectId);
      return { text: capLines(lessons.length ? lessons.map(row => `${row.id} ${row.scope}${row.enabled ? '' : ' · disabled'} · applied ${row.timesApplied} times · "${row.text}"${row.source.startsWith('override:') ? ` (from override of ${row.source.slice('override:'.length)})` : row.source === 'migrated' ? ' (from an earlier correction)' : ''}`) : ['No lessons yet.']) };
    }
    case 'lesson_edit': {
      const before = control.lessons(projectId).find(row => row.id === String(args.lesson).toUpperCase());
      const lesson = control.editLesson(projectId, String(args.lesson), { ...(typeof args.text === 'string' ? { text: args.text } : {}), ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}) });
      const changes = [before?.text !== lesson.text ? `text is now "${lesson.text}"` : '', before?.enabled !== lesson.enabled ? (lesson.enabled ? 'enabled' : 'disabled') : ''].filter(Boolean);
      return { text: `Updated ${lesson.id}: ${changes.join(', ') || 'no change'}.` };
    }
    case 'lesson_remove': { const lesson = control.editLesson(projectId, String(args.lesson), 'remove'); return { text: `Removed ${lesson.id}.` }; }
    case 'replay': {
      const proposal = typeof args.proposal === 'string' ? control.proposals().find(row => row.id === args.proposal!.toString().toUpperCase()) ?? null : null;
      if (typeof args.proposal === 'string' && !proposal) throw new OwnerRefusal(`${args.proposal} is not a proposal.`, 'proposal_not_found', 404);
      return { text: await control.replayText(projectId, proposal, typeof args.n === 'number' ? args.n : 20, typeof args.lesson === 'string' ? args.lesson : undefined) };
    }
  }
  throw new OwnerRefusal('jev takes rules, prompts, prompt_show, prompt_history, lessons, rule_set, rule_remove, prompt_propose, prompt_apply, prompt_rollback, lesson_edit, lesson_remove, replay.', 'unknown_action');
};
