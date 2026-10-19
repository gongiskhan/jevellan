import { VaultProjectSchema, stableJson, type Project, type ProjectDaily, type ProjectGoal, type ProjectJob, type ProjectWorkSettings, type VaultProject } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import type { ProjectWork } from './project-work.js';

/**
 * The project's definition as the vault keeps it (phase 5, `vault-project-v2`). Built field by field from an explicit list, so no
 * account id, device id, device path, revision or secret can travel: goals, jobs and dailies are named, never referenced by id.
 */
export function vaultDefinition(project: Project, settings: ProjectWorkSettings, goals: readonly ProjectGoal[], jobs: readonly ProjectJob[], dailies: readonly ProjectDaily[]): VaultProject {
  const goalName = (id: string | null) => id ? goals.find(goal => goal.id === id)?.name ?? null : null;
  const jobName = (id: string | null | undefined) => id ? jobs.find(job => job.id === id)?.name ?? null : null;
  const byName = <T extends { name: string }>(rows: T[]) => rows.sort((a, b) => a.name.localeCompare(b.name));
  return VaultProjectSchema.parse({
    schema: 'vault-project-v3', name: project.name, origin: project.remoteUrl ?? '', testCommand: project.testCommand ?? null, setupCommand: settings.setupCommand, gitPolicy: project.branchPolicy,
    work: { delivery: settings.delivery, autoLand: settings.autoLand, landingChecks: settings.landingChecks, smokeCheck: settings.smokeCheck, mergeCommitPaths: settings.mergeCommitPaths, healthChecks: settings.healthChecks, maxRunningThreads: settings.maxRunningThreads, maxRunningPerDevice: settings.maxRunningPerDevice,
      threadTurnCap: settings.threadTurnCap, instructions: settings.instructions, riskyAreas: settings.riskyAreas,
      nightlyWindow: settings.nightlyWindow, refill: settings.refill, memory: settings.memory, sessionCheckpoints: settings.sessionCheckpoints, compactAtPercent: settings.compactAtPercent, startMode: settings.startMode, maxNewThreadsPerDay: settings.maxNewThreadsPerDay, placement: settings.placement, prAutoFix: settings.prAutoFix, environment: settings.environment, notifications: settings.notifications,
      coordinator: { runtimeId: settings.coordinator.runtimeId ?? null, modelId: settings.coordinator.modelId, effort: settings.coordinator.effort } },
    goals: byName(goals.map(goal => ({ name: goal.name, state: goal.state, motivation: goal.motivation, health: goal.health, autonomy: goal.autonomy, dailyRefillCap: goal.dailyRefillCap, openPrCap: goal.openPrCap }))),
    jobs: byName(jobs.map(job => ({ name: job.name, goal: goalName(job.goalId), run: job.run, gate: jobName(job.gate?.jobId), enabled: job.enabled }))),
    dailies: byName(dailies.map(daily => ({ name: daily.name, goal: goalName(daily.goalId), order: daily.order, ...(daily.days ? { days: daily.days } : {}), enabled: daily.enabled,
      target: daily.target.kind === 'job' ? { kind: 'job', job: jobName(daily.target.jobId) ?? daily.name } : daily.target.kind === 'review-since-last' ? { kind: 'review-since-last' } : daily.target }))),
  });
}
export const vaultDefinitionText = (definition: VaultProject): string => `${JSON.stringify(JSON.parse(stableJson(definition)), null, 2)}\n`;

/** An existing goal, job or daily of this name, else one created with a request id derived from the vault folder and the name. */
export async function goalNamed(work: ProjectWork, projectId: string, input: Record<string, unknown> & { name: string }, requestId: string): Promise<ProjectGoal> {
  const existing = (await work.goals.list(projectId)).find(goal => goal.name === input.name);
  return existing ?? (await work.goals.create(projectId, { ...input, clientRequestId: requestId })).goal;
}
export async function jobNamed(work: ProjectWork, projectId: string, input: Record<string, unknown> & { name: string }, requestId: string): Promise<ProjectJob> {
  const existing = (await work.daily.jobs(projectId)).find(job => job.name === input.name);
  return existing ?? await ((input.run as { kind?: string } | undefined)?.kind === 'github-workflow' ? work.daily.restoreRetiredJob(projectId, { ...input, clientRequestId: requestId }) : work.daily.createJob(projectId, { ...input, clientRequestId: requestId }));
}
export async function dailyNamed(work: ProjectWork, projectId: string, input: Record<string, unknown> & { name: string }, requestId: string): Promise<ProjectDaily> {
  // A project has one memory dream: the memory sweep creates it under its own request id, so that id is shared here too.
  const dream = (input.target as { kind?: string } | undefined)?.kind === 'memory-dream';
  const find = async () => (await work.daily.dailies(projectId)).find(daily => dream ? daily.target.kind === 'memory-dream' : daily.name === input.name);
  const existing = await find(); if (existing) return existing;
  try { return await work.daily.createDaily(projectId, { ...input, clientRequestId: dream ? 'shared_memory_dream' : requestId }); }
  catch (error) { const raced = dream ? await find() : undefined; if (raced) return raced; throw error; }
}

/**
 * Recreates a project's work from its vault definition (phase 5.6): work settings, goals, jobs and dailies, matched by name so a
 * repeat, or the Ekoa Code preset before or after, never duplicates them; the coordinator notebook when the hub has none. The
 * coordinator account stays as this hub chose it.
 */
export async function restoreFromVault(work: ProjectWork, projectId: string, folder: string, raw: unknown, notebook: string | null): Promise<void> {
  const definition = VaultProjectSchema.parse(raw), id = (...parts: string[]) => derivedId('vault', folder, ...parts);
  const current = await work.admission.settings(projectId);
  const { schema: _schema, projectId: _project, revision, ...settings } = current; void _schema; void _project;
  const restored = { ...settings, ...definition.work, status: 'active' as const, setupCommand: definition.setupCommand, coordinator: { ...definition.work.coordinator, accountId: current.coordinator.accountId ?? null } };
  if (stableJson(restored) !== stableJson(settings)) await work.putSettings(projectId, { schema: 'project-work-settings-request-v1', revision, clientRequestId: id('settings', String(revision)), settings: restored });
  const goals = new Map<string, string>();
  for (const goal of definition.goals) goals.set(goal.name, (await goalNamed(work, projectId, { schema: 'goal-create-request-v1', ...goal }, id('goal', goal.name))).id);
  const goalId = (name: string | null) => name ? goals.get(name) ?? null : null;
  const jobs = new Map<string, ProjectJob>();
  for (const job of definition.jobs) jobs.set(job.name, await jobNamed(work, projectId, { schema: 'job-create-request-v1', name: job.name, goalId: goalId(job.goal), run: job.run, gate: null, enabled: job.enabled }, id('job', job.name)));
  for (const job of definition.jobs) {
    const saved = jobs.get(job.name)!, gate = job.gate ? jobs.get(job.gate) : undefined;
    if (gate && saved.gate?.jobId !== gate.id) jobs.set(job.name, await work.daily.updateJob(projectId, saved.id, { schema: 'job-update-request-v1', expectedRevision: saved.revision,
      name: saved.name, goalId: saved.goalId, run: saved.run, enabled: saved.enabled, gate: { jobId: gate.id } }));
  }
  for (const daily of definition.dailies) {
    const target = daily.target.kind === 'job' ? jobs.get(daily.target.job) : undefined;
    if (daily.target.kind === 'job' && !target) continue;
    await dailyNamed(work, projectId, { schema: 'daily-create-request-v1', name: daily.name, goalId: goalId(daily.goal), order: daily.order, ...(daily.days ? { days: daily.days } : {}), enabled: daily.enabled && target?.run.kind !== 'github-workflow',
      target: daily.target.kind === 'job' ? { kind: 'job', jobId: target!.id } : daily.target }, id('daily', daily.name));
  }
  const stored = await work.notebookView(projectId);
  if (notebook?.trim() && !stored.notebook?.content.trim()) await work.putNotebook(projectId, { schema: 'notebook-request-v1', expectedRevision: stored.revision, content: notebook });
}
