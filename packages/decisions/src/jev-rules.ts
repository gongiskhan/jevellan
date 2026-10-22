import { EffortSchema, type Effort, type JevRule } from '@jevellan/core';

export type JevRuleContext = { taskType?: string | undefined; goalId?: string | null | undefined; label?: string | undefined; text: string };

/** Only predicates explicitly configured by the owner match; there is no built-in meaning routing. */
export function matchingJevRules(projectId: string, rules: readonly JevRule[], context: JevRuleContext) {
  return rules.flatMap(rule => {
    if (!rule.enabled || rule.scope === 'project' && rule.projectId !== projectId) return [];
    let fields = 0;
    if (rule.when.taskType) { if (rule.when.taskType !== context.taskType) return []; fields++; }
    if (rule.when.goalId) { if (rule.when.goalId !== context.goalId) return []; fields++; }
    if (rule.when.label) { if (rule.when.label.toLowerCase() !== (context.label ?? '').toLowerCase()) return []; fields++; }
    if (rule.when.keywords?.length) { if (!rule.when.keywords.some(word => context.text.toLowerCase().includes(word.toLowerCase()))) return []; fields++; }
    return [{ rule, fields }];
  });
}

/** Select each field by scope/specificity; opposing winners use that priority, then the higher floor. */
export function jevEffortBounds(projectId: string, rules: readonly JevRule[], context: JevRuleContext) {
  const efforts = EffortSchema.options, index = (effort: Effort) => efforts.indexOf(effort);
  const ranked = matchingJevRules(projectId, rules, context).filter(({ rule }) => rule.set.minEffort || rule.set.maxEffort);
  type Match = typeof ranked[number];
  const priority = (a: Match, b: Match) => Number(b.rule.scope === 'project') - Number(a.rule.scope === 'project') || b.fields - a.fields;
  let lower = ranked.filter(row => row.rule.set.minEffort).sort((a,b) => priority(a,b) || index(b.rule.set.minEffort!) - index(a.rule.set.minEffort!) || Number(a.rule.id.slice(1))-Number(b.rule.id.slice(1)))[0];
  let upper = ranked.filter(row => row.rule.set.maxEffort).sort((a,b) => priority(a,b) || index(a.rule.set.maxEffort!) - index(b.rule.set.maxEffort!) || Number(a.rule.id.slice(1))-Number(b.rule.id.slice(1)))[0];
  if (lower && upper && index(lower.rule.set.minEffort!) > index(upper.rule.set.maxEffort!)) {
    if (priority(lower,upper) <= 0) upper = undefined; else lower = undefined;
  }
  const accepted = [...new Map([lower,upper].flatMap(row=>row?[row.rule]:[]).map(rule=>[rule.id,rule])).values()];
  return { minimum: lower?.rule.set.minEffort ?? 'low', maximum: upper?.rule.set.maxEffort ?? 'max', accepted,
    ignored: ranked.filter(row=>!accepted.some(rule=>rule.id===row.rule.id)).map(row=>row.rule.id) };
}

export function applyJevEffortRules(projectId: string, effort: Effort, rules: readonly JevRule[], context: JevRuleContext) {
  const bounds = jevEffortBounds(projectId, rules, context), efforts = EffortSchema.options, from = efforts.indexOf(effort);
  const effective = efforts[Math.min(efforts.indexOf(bounds.maximum), Math.max(efforts.indexOf(bounds.minimum), from))]!;
  const changed = effective !== effort, raised = efforts.indexOf(effective) > from;
  const rule = changed ? bounds.accepted.find(row => raised ? row.set.minEffort === bounds.minimum : row.set.maxEffort === bounds.maximum) : undefined;
  return { effort: effective, minimum: bounds.minimum, maximum: bounds.maximum, rulesApplied: rule ? [rule.id] : [], ignored: bounds.ignored,
    reason: rule ? `${rule.id} ${raised ? 'raised' : 'lowered'} effort from ${effort} to ${effective}${rule.note ? ` (${rule.note})` : ''}.` : '' };
}
