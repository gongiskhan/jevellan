import { existsSync } from 'node:fs';
import { EkoaCodeSetupReceiptSchema, EkoaCodeSetupRequestSchema, ProjectWorkSettingsSchema, readDocument, writeDocument, stableJson, type ProjectGoal, type ProjectWorkSettings } from '@jevellan/core';
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
export const EKOA_LANDING_CHECKS = [
  {
    "name": "security",
    "paths": [
      "api/src/auth/",
      "api/src/security/",
      "api/src/billing/",
      "api/src/memvault/",
      "api/src/routes/",
      "api/src/llm/",
      "shared/",
      "web/app/login/",
      "web/app/activate/",
      "web/app/change-password/"
    ],
    "command": "npm run test:suite -- security"
  },
  {
    "name": "platform",
    "paths": [
      "shared/",
      "api/src/data/",
      "api/src/events/",
      "api/src/journal/",
      "api/src/services/",
      "api/src/config.ts",
      "deploy/",
      "scripts/",
      "package.json",
      "package-lock.json",
      "api/package.json"
    ],
    "command": "npm run test:suite -- platform"
  },
  {
    "name": "chat",
    "paths": [
      "api/src/agents/",
      "api/src/apps/",
      "api/src/approvals/",
      "api/src/llm/",
      "api/src/judge/",
      "api/src/memory/",
      "api/src/voice/",
      "api/src/voice-spike/",
      "api/src/streaming/",
      "web/app/(dashboard)/t/",
      "web/app/(dashboard)/aprovacoes/"
    ],
    "command": "npm run test:suite -- chat"
  },
  {
    "name": "caixa",
    "paths": [
      "api/src/arrivals/",
      "api/src/inbox/",
      "api/src/whatsapp/",
      "api/src/notifications/",
      "web/app/(dashboard)/caixa/"
    ],
    "command": "npm run test:suite -- caixa"
  },
  {
    "name": "tarefas",
    "paths": [
      "api/src/tasks/",
      "api/src/calendar/",
      "api/src/schedules/",
      "web/app/(dashboard)/tarefas/",
      "web/app/(dashboard)/calendario/"
    ],
    "command": "npm run test:suite -- tarefas"
  },
  {
    "name": "arquivo",
    "paths": [
      "api/src/archive/",
      "api/src/documents/",
      "api/src/knowledge/",
      "api/src/uploads/",
      "api/src/extraction/",
      "api/src/content/",
      "api/src/search/",
      "web/app/(dashboard)/arquivo/",
      "web/app/(dashboard)/documentos/",
      "web/app/(dashboard)/conhecimento/"
    ],
    "command": "npm run test:suite -- arquivo"
  },
  {
    "name": "clientes",
    "paths": [
      "api/src/clients/",
      "api/src/legal/",
      "api/src/legal-index/",
      "api/src/kyc/",
      "api/src/proposals/",
      "api/src/register-lint/",
      "web/app/(dashboard)/clientes/"
    ],
    "command": "npm run test:suite -- clientes"
  },
  {
    "name": "integracoes",
    "paths": [
      "api/src/integrations/",
      "api/src/automation/",
      "api/src/cofre/",
      "api/src/connector/",
      "api/src/bridge/",
      "api/src/local-drivers/",
      "bridge/",
      "desktop/",
      "cli/",
      "mcp/",
      "web/app/(dashboard)/integracoes/",
      "web/app/(dashboard)/ligacoes/"
    ],
    "command": "npm run test:suite -- integracoes"
  },
  {
    "name": "shell",
    "paths": [
      "web/"
    ],
    "command": "npm run test:suite -- shell"
  }
];
export const EKOA_MERGE_COMMIT_PATHS = ["evals/", "api/src/legal/", "api/src/legal-index/", "scripts/legal-quality/", "docs/legal-quality/"];
async function ekoaCommand(work: ProjectWork, projectId: string, name: string, goalId: string | null, command: string, needs: string[], key: string, legal = false) {
  const run = { kind: 'command' as const, command, needs, cwd: 'workspace' as const, timeoutMinutes: 600, ...(legal ? { deliveryGate: { id: 'ekoa-legal-promotion-v1', command: 'node "$JEVELLAN_JOB_COMMAND_CHECKOUT/scripts/jevellan/legal-gate.mjs"', timeoutMinutes: 120, protectedPaths: ['evals/', '.github/', 'scripts/jevellan/', 'scripts/legal-quality/'] } } : {}) };
  let job = await jobNamed(work, projectId, { schema: 'job-create-request-v1', name, goalId, enabled: true, gate: null, run }, key);
  if (stableJson(job.run) !== stableJson(run) || !job.enabled || job.goalId !== goalId) job = await work.daily.updateJob(projectId, job.id, { schema: 'job-update-request-v1', expectedRevision: job.revision, name, goalId, enabled: true, gate: null, run });
  return job;
}
/** Owner-only, repeatable setup. Stable create IDs preserve later owner edits and avoid duplicate goals/jobs. */
export async function applyEkoaCodeSetup(work: ProjectWork, projectId: string, raw: unknown, path: string, current: ProjectWorkSettings) {
  // Derived Jev policy is read-time input, not durable owner configuration.
  const { jevPolicy: _derived, ...configuration } = current; void _derived;
  current = ProjectWorkSettingsSchema.parse(configuration);
  const input = EkoaCodeSetupRequestSchema.parse(raw);
  let receipt = existsSync(path) ? readDocument(path, EkoaCodeSetupReceiptSchema) : null;
  if (receipt && (receipt.projectId !== projectId || receipt.modelId !== input.modelId || receipt.workflowPull !== input.workflowPull)) throw Object.assign(new Error('Ekoa Code setup already has a different receipt.'), { status: 409 });
  if (receipt?.completed && receipt.presetVersion === 3) return receipt;
  if (!receipt) {
    receipt = EkoaCodeSetupReceiptSchema.parse({ ...input, schema: 'ekoa-code-setup-receipt-v1', projectId, completed: false, presetVersion: 3, settings: current });
    writeDocument(path, EkoaCodeSetupReceiptSchema, receipt);
  }
  const goals: ProjectGoal[] = [];
  // Matched by name as well as by request id: a project restored from the vault already has these goals, jobs and dailies.
  for (const [index, goal] of EKOA_GOALS.entries()) goals.push(await goalNamed(work, projectId, { schema: 'goal-create-request-v1', ...goal, autonomy: 'propose', dailyRefillCap: 3, openPrCap: 2 }, `ekoa_setup_goal_${index}`));
  await configureEkoaNights(work, projectId);
  const jobs = await work.daily.jobs(projectId);
  const deploy = await ekoaCommand(work, projectId, 'Deploy', null, 'node "$JEVELLAN_JOB_COMMAND_CHECKOUT/scripts/jevellan/deploy.mjs"', ['prod-access'], 'ekoa_deploy_command_v3');
  const desktop = await ekoaCommand(work, projectId, 'Desktop build', null, 'node "$JEVELLAN_JOB_COMMAND_CHECKOUT/scripts/jevellan/desktop.mjs"', ['mac', 'residential'], 'ekoa_desktop_command_v3');
  if (!receipt.settingsPrepared || receipt.presetVersion !== 3) {
    const planned = ProjectWorkSettingsSchema.parse({ ...current,
    delivery: 'land', autoLand: true, maxRunningThreads: 6, riskyAreas: current.riskyAreas || EKOA_RISKY_AREAS, landingChecks: EKOA_LANDING_CHECKS, smokeCheck: EKOA_FAST_CHECKS, mergeCommitPaths: EKOA_MERGE_COMMIT_PATHS,
    setupCommand: current.setupCommand ?? 'npm ci', memory: { mode: 'hub', capture: true, dreamMode: 'apply' }, deploy: { mode: 'approve', jobId: deploy.id, desktopJobId: desktop.id, suiteJobId: jobs.find(row => row.name === 'Full suite')!.id },
    notifications: { ...current.notifications, quietHours: { enabled: true, start: '23:00', end: '08:00', timezone: 'Europe/Lisbon' } }, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } });
    receipt = { ...receipt, presetVersion: 3, settingsPrepared: true, completed: false, settings: planned };
    writeDocument(path, EkoaCodeSetupReceiptSchema, receipt);
  }
  const { schema: _savedSchema, projectId: _savedProject, revision: plannedRevision, ...plannedSettings } = receipt.settings; void _savedSchema; void _savedProject;
  const saved = await work.putSettings(projectId, { schema: 'project-work-settings-request-v1', revision: plannedRevision, clientRequestId: derivedId('ekoa_setup_v3', projectId, String(plannedRevision)), settings: plannedSettings });
  receipt = { ...receipt, completed: true, presetVersion: 3, settings: saved.settings }; writeDocument(path, EkoaCodeSetupReceiptSchema, receipt); return receipt;
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
  const legal = await ekoaCommand(work, projectId, 'Legal programme night', legalGoal.id, 'node scripts/jevellan/legal-night.mjs', ['linux'], 'ekoa_legal_command_v3', true);
  const full = await ekoaCommand(work, projectId, 'Full suite', resilience.id, 'node scripts/jevellan/full-suite.mjs', ['linux'], 'ekoa_full_command_v3');
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
