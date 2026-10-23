import {type JevRule} from '@jevellan/core';
import {capLines} from '@jevellan/projects';
import {OwnerRefusal,type OwnerHandler} from '../owner-tools.js';
import {resolveGoal} from './common.js';

function describeRule(rule: JevRule, goals: Map<string, string>): string {
  const when = [rule.when.taskType ? `task type ${rule.when.taskType}` : '', rule.when.goalId ? `goal ${goals.get(rule.when.goalId) ?? rule.when.goalId}` : '', rule.when.label ? `label ${rule.when.label}` : '', rule.when.keywords?.length ? `keywords ${rule.when.keywords.join(', ')}` : ''].filter(Boolean);
  const set = [rule.set.minModel ? `at least ${rule.set.minModel}` : '', rule.set.minEffort ? `at least ${rule.set.minEffort} effort` : '', rule.set.maxEffort ? `at most ${rule.set.maxEffort} effort` : '', rule.set.account ? `account ${rule.set.account}` : '', rule.set.runtime ? `runtime ${rule.set.runtime}` : '', rule.set.landingRoute ? `landing route ${rule.set.landingRoute}` : ''].filter(Boolean);
  return [rule.id, rule.scope, ...(rule.enabled ? [] : ['disabled']), ...(when.length ? when : ['always']), set.join(', '), ...(rule.note ? [`"${rule.note}"`] : [])].join(' · ');
}

export const JEV_CONTROL_ACTIONS=new Set(['rules','rule_set','rule_remove','replay_report','prompts','prompt_show','prompt_history','prompt_propose','prompt_apply','prompt_rollback','lessons','lesson_edit','lesson_remove','replay']);
export const jevControlAction:OwnerHandler=async(context)=>{
 const {app,tools,project,args}=context,control=app.ownerJev,projectId=project.id;
 await control.prepare(projectId);
 await tools.status(project);
 const goals=new Map((await app.projectWork.goalList(projectId)).goals.map(row=>[row.goal.id,tools.ids.one(projectId,'G',row.goal.id)]));
 switch(context.action){
    case 'rules': { const rules = control.rules(projectId); return { text: capLines([`Jev rules for ${project.name} (global and project)`, ...(rules.length ? rules.map(rule => describeRule(rule, goals)) : ['none'])]) }; }
    case 'rule_set': {
      const when = (args.when ?? {}) as { taskType?: string; goal?: string; label?: string; keywords?: string[] };
      const goalId = when.goal ? (await resolveGoal(context, when.goal)).goal.id : undefined;
      const rule = await control.saveRule(projectId, { ...(typeof args.replace === 'boolean' ? { replace: args.replace } : {}), ...(typeof args.rule === 'string' ? { rule: args.rule } : {}), ...(args.scope ? { scope: args.scope as 'global' | 'project' } : {}),
        when: { ...(when.taskType ? { taskType: when.taskType } : {}), ...(goalId ? { goalId } : {}), ...(when.label ? { label: when.label } : {}), ...(when.keywords ? { keywords: when.keywords } : {}) },
        ...(args.set ? { set: args.set as JevRule['set'] } : {}), ...(typeof args.note === 'string' ? { note: args.note } : {}), ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}) });
      return { text: `Saved ${describeRule(rule, goals).replace(/^(R\d+) · /u, '$1: ')}. Applies to new decisions from now on.\n${await control.ruleEffect(projectId)}` };
    }
    case 'rule_remove': { const rule = control.removeRule(projectId, String(args.rule)); return { text: `Removed ${rule.id}.\n${await control.ruleEffect(projectId)}` }; }
    case 'replay_report': return { text: 'Stored Jev replay report.', data: control.replayReport(projectId, String(args.report)) };
    case 'prompts': {
      const versions = control.versions(); const names = [...new Set(versions.map(row => row.name))];
      const lines = names.map(name => { const rows = versions.filter(row => row.name === name); const live = rows.find(row => row.active)!; return `${name} v${live.version} live · ${rows.length} version${rows.length === 1 ? '' : 's'}`; });
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
 throw new OwnerRefusal('Unknown Jev control action.','unknown_action');
};
