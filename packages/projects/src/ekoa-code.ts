import { existsSync } from 'node:fs';
import { EkoaCodeSetupReceiptSchema, EkoaCodeSetupRequestSchema, ProjectWorkSettingsSchema, readDocument, writeDocument, type ProjectGoal, type ProjectWorkSettings } from '@jevellan/core';
import type { ProjectWork } from './project-work.js';
import { derivedId } from './decision-items.js';
import { dailyNamed, goalNamed, jobNamed } from './vault-definition.js';
export const EKOA_FAST_CHECKS = 'npm run build --workspace shared && npm run typecheck && npm run lint';
export const EKOA_RISKY_AREAS = 'Tenancy and cross-user data access; the Cofre and credentials; the LLM egress module and the Judge; database migrations and stored data shapes; deploy, CI and infrastructure files; billing; evals/.';
export const EKOA_THREAD_RULES = `Ekoa Code rules:
- Follow the repository's own agent instructions.
- Never edit evals/ or anything that defines how the legal programme is measured.
- Never touch production (go.ekoa.io) or deploy; never run token-spending tests.
- Test accounts only in the office named "(APAGAR)". Ekoa never sends WhatsApp messages.
- Secrets live only in the Jevellan vault, never in the repository.
- Check user-facing changes at 390 px width as well as desktop.
- When you add to docs/decisions.md or docs/findings.md, add new entries at the end only.`;
export const EKOA_GOALS = [
  { name: 'Resilience', state: 'active', motivation: 'Nothing breaks without a test noticing, and what lands stays clear and consistent: the nightly full suite and the nightly review, with every finding fixed or dismissed in writing.', health: 'The nightly full suite is green; review findings are few and closed within days.' },
  { name: 'Hardening through code review', state: 'done', motivation: 'The code stays clear and consistent while agents write most of it. A daily review of what merged catches structure problems, duplication and rule breaks early.', health: 'Open review findings are few and get fixed within days; the architecture rules in the repository hold.' },
  { name: 'Legal analysis quality', state: 'active', motivation: 'Ekoa gives lawyers better and deeper analysis than a raw model, with every statement of law cited or marked unverified.', health: 'The legal gates in evals/legal/gates.json hold.' },
  { name: 'Integrations and automations', state: 'paused', motivation: 'Integrations work in daily use for real offices, Citius and Finanças first.', health: 'Integration actions succeed in daily use and in the Mac runs.' },
  { name: 'API and MCP', state: 'paused', motivation: 'The Cortex API and the Ekoa MCP are robust and valuable for daily work.', health: 'Errors and gaps met in daily use are few and get fixed quickly.' },
  { name: 'Security', state: 'paused', motivation: 'No cross-user exposure, no leaked secrets, ready for the pentest. Findings will come from the Ekoa Security project.', health: 'Findings from Ekoa Security are triaged and closed.' },
] as const;
/** Owner-only, repeatable setup. Stable create IDs preserve later owner edits and avoid duplicate goals/jobs. */
export async function applyEkoaCodeSetup(work: ProjectWork, projectId: string, raw: unknown, path: string, current: ProjectWorkSettings) {
  const input = EkoaCodeSetupRequestSchema.parse(raw);
  let receipt = existsSync(path) ? readDocument(path, EkoaCodeSetupReceiptSchema) : null;
  if (receipt && (receipt.projectId !== projectId || receipt.modelId !== input.modelId || receipt.workflowPull !== input.workflowPull)) throw Object.assign(new Error('Ekoa Code setup already has a different receipt.'), { status: 409 });
  if (receipt?.completed) {
    if (receipt.presetVersion === 1) {
      const { schema: _schema, projectId: _project, revision, ...settings } = current; void _schema; void _project;
      const saved = await work.putSettings(projectId, { schema: 'project-work-settings-request-v1', revision, clientRequestId: derivedId('ekoa_setup', projectId, 'hub_memory'), settings: { ...settings, memory: { mode: 'hub', capture: true, dreamMode: 'apply' } } });
      await dailyNamed(work, projectId, { schema: 'daily-create-request-v1', name: 'Memory dream', goalId: null, order: 0, enabled: true, target: { kind: 'memory-dream' } }, 'shared_memory_dream');
      receipt = { ...receipt, presetVersion: 2, settings: saved.settings }; writeDocument(path, EkoaCodeSetupReceiptSchema, receipt);
    }
    return receipt;
  }
  if (!receipt) {
    receipt = EkoaCodeSetupReceiptSchema.parse({ ...input, schema: 'ekoa-code-setup-receipt-v1', projectId, completed: false, presetVersion: 2, settings: ProjectWorkSettingsSchema.parse({ ...current,
      defaultIsolation: 'worktree', allowMainIsolation: false, autoMerge: false, riskyAreas: EKOA_RISKY_AREAS, requiredChecks: ['result'], setupCommand: 'npm ci', instructions: EKOA_THREAD_RULES, memory: { mode: 'hub', capture: true, dreamMode: 'apply' },
      maxRunningThreads: 8, maxRunningPerDevice: 6, coordinator: { modelId: input.modelId, runtimeId: 'claude', accountId: null, effort: 'high' }, refill: { enabled: true, minIntervalMinutes: 30 }, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } }) });
    writeDocument(path, EkoaCodeSetupReceiptSchema, receipt);
  }
  const goals: ProjectGoal[] = [];
  // Matched by name as well as by request id: a project restored from the vault already has these goals, jobs and dailies.
  for (const [index, goal] of EKOA_GOALS.entries()) goals.push(await goalNamed(work, projectId, { schema: 'goal-create-request-v1', ...goal, autonomy: 'propose', dailyRefillCap: 3, openPrCap: 2 }, `ekoa_setup_goal_${index}`));
  await configureEkoaNights(work, projectId);
  const { schema: _schema, projectId: _project, revision, ...settings } = receipt.settings; void _schema; void _project;
  await work.putSettings(projectId, { schema: 'project-work-settings-request-v1', revision, clientRequestId: derivedId('ekoa_setup', projectId), settings });
  receipt = { ...receipt, completed: true }; writeDocument(path, EkoaCodeSetupReceiptSchema, receipt); return receipt;
}

/** Revision-checked migration: keep identifiers and history while replacing the retired nights. */
export async function configureEkoaNights(work: ProjectWork, projectId: string) {
  let goals = await work.goals.list(projectId);
  const old = goals.find(goal => goal.name === 'Hardening through automated tests');
  if (old) await work.goals.update(projectId, old.id, { schema: 'goal-update-request-v1', expectedRevision: old.revision, name: 'Resilience',
    motivation: 'Nothing breaks without a test noticing, and what lands stays clear and consistent: the nightly full suite and the nightly review, with every finding fixed or dismissed in writing.',
    health: 'The nightly full suite is green; review findings are few and closed within days.' });
  goals = await work.goals.list(projectId);
  for (const goal of goals) {
    const state = goal.name === 'Legal analysis quality' ? 'active' : goal.name === 'Hardening through code review' ? 'done' : goal.name === 'Security' ? 'paused' : goal.state;
    if (state !== goal.state) await work.goals.update(projectId, goal.id, { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state });
  }
  const resilience = goals.find(goal => goal.name === 'Resilience')!, legalGoal = goals.find(goal => goal.name === 'Legal analysis quality')!;
  if (!resilience || !legalGoal) throw new Error('The night programme needs its Resilience and Legal analysis quality goals.');
  for (const job of await work.daily.jobs(projectId)) if (job.run.kind === 'github-workflow' && job.enabled) await work.daily.updateJob(projectId, job.id, { schema: 'job-update-request-v1', expectedRevision: job.revision, name: job.name, goalId: job.goalId, enabled: false, gate: job.gate, run: job.run });
  const legal = await jobNamed(work, projectId, { schema: 'job-create-request-v1', name: 'Legal programme night', goalId: legalGoal.id, enabled: true, gate: null, run: { kind: 'command', command: 'node scripts/jevellan/legal-night.mjs', needs: ['prod-access'], cwd: 'workspace', timeoutMinutes: 240 } }, 'ekoa_legal_command_v3');
  const full = await jobNamed(work, projectId, { schema: 'job-create-request-v1', name: 'Full suite', goalId: resilience.id, enabled: true, gate: null, run: { kind: 'command', command: 'node scripts/jevellan/full-suite.mjs', needs: ['linux'], cwd: 'workspace', timeoutMinutes: 240 } }, 'ekoa_full_command_v3');
  const dailies = await work.daily.dailies(projectId);
  const definitions = [
    { name: 'Memory dream', goalId: null, order: 0, target: { kind: 'memory-dream' } },
    { name: 'Legal programme night', goalId: legalGoal.id, order: 1, target: { kind: 'job', jobId: legal.id } },
    { name: 'Full suite', goalId: resilience.id, order: 2, target: { kind: 'job', jobId: full.id } },
    { name: 'Review since last', goalId: resilience.id, order: 3, target: { kind: 'review-since-last' } },
  ];
  const replaced = new Set<string>();
  for (const definition of definitions) {
    const existing = dailies.find(daily => daily.name === definition.name || definition.target.kind === 'memory-dream' && daily.target.kind === 'memory-dream' || definition.target.kind === 'review-since-last' && daily.target.kind === 'review-since-last' || definition.name === 'Full suite' && daily.name === 'Full suite with the expensive tests' || definition.name === 'Legal programme night' && daily.name === 'Legal programme');
    if (existing) replaced.add(existing.id);
    if (existing) await work.daily.updateDaily(projectId, existing.id, { schema: 'daily-update-request-v1', expectedRevision: existing.revision, ...definition, enabled: true });
    else await dailyNamed(work, projectId, { schema: 'daily-create-request-v1', ...definition, enabled: true }, `ekoa_night_v3_${definition.order}`);
  }
  for (const daily of dailies) if (!replaced.has(daily.id) && daily.target.kind === 'job' && ![legal.id, full.id].includes(daily.target.jobId) && daily.enabled) {
    const oldJob = (await work.daily.jobs(projectId)).find(job => job.id === (daily.target.kind === 'job' ? daily.target.jobId : ''));
    if (oldJob?.run.kind === 'github-workflow') await work.daily.o.hub.putDaily({ ...daily, enabled: false, updatedAt: work.tasks.at() }, daily.revision);
  }
  await dailyNamed(work, projectId, { schema: 'daily-create-request-v1', name: 'Latest Anthropic models', goalId: null, order: 4, enabled: false, days: ['mon'], target: { kind: 'session', title: 'Latest Anthropic models', brief: "Check Anthropic's current models and open the model-update work the repository's process describes, if there is a newer one.", type: 'ops' } }, 'ekoa_models_monday_v3');
  return { legal, full };
}
