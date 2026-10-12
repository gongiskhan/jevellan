import { existsSync } from 'node:fs';
import { EkoaCodeSetupReceiptSchema, EkoaCodeSetupRequestSchema, ProjectWorkSettingsSchema, readDocument, writeDocument, type ProjectGoal, type ProjectWorkSettings } from '@jevellan/core';
import type { ProjectWork } from './project-work.js';
import { derivedId } from './decision-items.js';
export const EKOA_FAST_CHECKS = 'npm run build --workspace shared && npm run typecheck && npm run lint';
export const EKOA_RISKY_AREAS = 'Tenancy and cross-user data access; the Cofre and credentials; the LLM egress module and the Judge; database migrations and stored data shapes; deploy, CI and infrastructure files; billing; evals/.';
export const EKOA_THREAD_RULES = `Ekoa Code rules:
- Follow the repository's own agent instructions.
- Never edit evals/ or anything that defines how the legal programme is measured.
- Never touch production (go.ekoa.io) or deploy; never run token-spending tests.
- Test accounts only in the office named "(APAGAR)". Ekoa never sends WhatsApp messages.
- Secrets live only in GitHub secrets; never add one to the repository.
- Check user-facing changes at 390 px width as well as desktop.
- When you add to docs/decisions.md or docs/findings.md, add new entries at the end only.`;
export const EKOA_GOALS = [
  { name: 'Hardening through automated tests', state: 'active', motivation: 'Nothing in Ekoa should break without a test noticing. Every finding ends in a test or a written dismissal, and the nightly suite stays green.', health: 'The nightly suite is green; open CI findings trend to zero; no regressions reach production.' },
  { name: 'Hardening through code review', state: 'active', motivation: 'The code stays clear and consistent while agents write most of it. A daily review of what merged catches structure problems, duplication and rule breaks early.', health: 'Open review findings are few and get fixed within days; the architecture rules in the repository hold.' },
  { name: 'Legal analysis quality', state: 'paused', motivation: 'Ekoa gives lawyers better and deeper analysis than a raw model, with every statement of law cited or marked unverified.', health: 'The legal gates in evals/legal/gates.json hold.' },
  { name: 'Integrations and automations', state: 'paused', motivation: 'Integrations work in daily use for real offices, Citius and Finanças first.', health: 'Integration actions succeed in daily use and in the Mac runs.' },
  { name: 'API and MCP', state: 'paused', motivation: 'The Cortex API and the Ekoa MCP are robust and valuable for daily work.', health: 'Errors and gaps met in daily use are few and get fixed quickly.' },
  { name: 'Security', state: 'paused', motivation: 'No cross-user exposure, no leaked secrets, ready for the pentest. Findings will come from the Ekoa Security project.', health: 'Findings from Ekoa Security are triaged and closed.' },
] as const;
/** Owner-only, repeatable setup. Stable create IDs preserve later owner edits and avoid duplicate goals/jobs. */
export async function applyEkoaCodeSetup(work: ProjectWork, projectId: string, raw: unknown, path: string, current: ProjectWorkSettings) {
  const input = EkoaCodeSetupRequestSchema.parse(raw);
  let receipt = existsSync(path) ? readDocument(path, EkoaCodeSetupReceiptSchema) : null;
  if (receipt && (receipt.projectId !== projectId || receipt.modelId !== input.modelId || receipt.workflowPull !== input.workflowPull)) throw Object.assign(new Error('Ekoa Code setup already has a different receipt.'), { status: 409 });
  if (receipt?.completed) return receipt;
  if (!receipt) {
    receipt = EkoaCodeSetupReceiptSchema.parse({ ...input, schema: 'ekoa-code-setup-receipt-v1', projectId, completed: false, settings: ProjectWorkSettingsSchema.parse({ ...current,
      defaultIsolation: 'worktree', allowMainIsolation: false, autoMerge: false, riskyAreas: EKOA_RISKY_AREAS, requiredChecks: ['result'], setupCommand: 'npm ci', threadRules: EKOA_THREAD_RULES,
      maxRunningThreads: 8, maxRunningPerDevice: 6, coordinator: { modelId: input.modelId, runtimeId: 'claude', accountId: null, effort: 'high' }, refill: { enabled: true, minIntervalMinutes: 30 }, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } }) });
    writeDocument(path, EkoaCodeSetupReceiptSchema, receipt);
  }
  const goals: ProjectGoal[] = [];
  for (const [index, goal] of EKOA_GOALS.entries()) goals.push((await work.goals.create(projectId, { schema: 'goal-create-request-v1', clientRequestId: `ekoa_setup_goal_${index}`, ...goal, autonomy: 'propose', dailyRefillCap: 3, openPrCap: 2 })).goal);
  const workflow = (name: string, file: string, goalIndex: number | null, watchOrder: number, extras = {}) => ({ schema: 'job-create-request-v1', clientRequestId: `ekoa_setup_${file.replaceAll('.', '_')}`, name, goalId: goalIndex === null ? null : goals[goalIndex]!.id, enabled: true, gate: null,
    run: { kind: 'github-workflow', workflow: file, mode: 'dispatch', timeoutMinutes: 420, pinCommitRef: false, schedulerSwitch: { schema: 'workflow-scheduler-switch-v1', variable: 'NIGHTLY_SCHEDULER', dispatchValue: 'jevellan', ownerMergePull: input.workflowPull, watchOrder }, ...extras } });
  const chain = (event: 'schedule' | 'workflow_run', afterWorkflow?: string) => ({ schema: 'workflow-watch-chain-v1', event, excludeTitle: '(not in the chain)', ...(afterWorkflow ? { afterWorkflow } : { titleSuffix: ' night' }) });
  const legal = await work.daily.createJob(projectId, workflow('Legal programme', 'nightly-legal-programme.yml', 2, 1, { inputs: { mode: 'night', dry_run: 'false', test_mode: 'false' }, watchChain: chain('schedule') }));
  const full = await work.daily.createJob(projectId, workflow('Full suite with the expensive tests', 'nightly-all-tests.yml', 0, 3, { commitInput: 'sha', watchChain: chain('workflow_run', 'nightly-deploy.yml'), inputs: { expensive: 'true' }, requiredJobs: ['suite', 'expensive'], requiredSteps: ['every sub-suite, the browser estate and the phone-width specs', 'the expensive tests'] }));
  const deploy = await work.daily.createJob(projectId, { ...workflow('Deploy', 'nightly-deploy.yml', null, 2, { commitInput: 'sha', watchChain: chain('workflow_run', 'nightly-legal-programme.yml') }), gate: { jobId: full.id } });
  const definitions = [{ name: 'Review since last', goalId: goals[1]!.id, enabled: true, target: { kind: 'review-since-last' } }, ...[legal, full, deploy].map(job => ({ name: job.name, goalId: job.goalId, enabled: job.enabled, target: { kind: 'job', jobId: job.id } })),
    { name: 'Security', goalId: goals[5]!.id, enabled: false, target: { kind: 'session', title: 'Security programme', brief: 'Security is parked until the owner provides the Ekoa Security programme. Report that this input is required.', type: 'ops' } }];
  for (const [order, definition] of definitions.entries()) await work.daily.createDaily(projectId, { schema: 'daily-create-request-v1', clientRequestId: `ekoa_setup_nightly_${order}`, order, ...definition });
  const { schema: _schema, projectId: _project, revision, ...settings } = receipt.settings; void _schema; void _project;
  await work.putSettings(projectId, { schema: 'project-work-settings-request-v1', revision, clientRequestId: derivedId('ekoa_setup', projectId), settings });
  receipt = { ...receipt, completed: true }; writeDocument(path, EkoaCodeSetupReceiptSchema, receipt); return receipt;
}
