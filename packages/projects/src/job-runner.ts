import { placeCommandJob } from './job-placement.js';
import type { DeviceView, ThreadIndex } from '@jevellan/core';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deviceAllowsWork, ProjectJobFindingsSchema, ProjectJobRunSchema, resolveProjectPath, type CoordinatorEvent, type Homes, type Project, type ProjectHub, type ProjectJob, type ProjectJobRun, type ProjectWorkTask, type ProjectWorkSettings, type SecretRedactor } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import { ThreadGit, threadBaseRef } from './git.js';
import type { GitHubAccess } from './publication.js';
import type { ProjectTasks } from './tasks.js';
import { outputTail, runThreadCommand, SETUP_TIMEOUT_MS } from './verification.js';
import { parseWorktrees } from './worktree.js';
import { readDocument, writeDocument, TurnProcessSchema, type NativeProcess } from '@jevellan/core';
import { z } from 'zod';
import { collectDeviceFacts, deviceResourceRefusal, type DeviceFacts } from '@jevellan/core';
import { endTurnProcess } from './recovery.js';
const JobProcessSchema = TurnProcessSchema.extend({ schema: z.literal('project-job-process-v1') });

export class ProjectJobRunner {
  readonly #running = new Map<string, { id: string; controller: AbortController; promise: Promise<void> }>();
  readonly #starting = new Set<string>();
  #closed = false;
  constructor(readonly o: { projectEnvironment?(projectId: string): Promise<Record<string, string>>; homes: Homes; hub: ProjectHub; tasks: ProjectTasks; git: ThreadGit; github: GitHubAccess; deviceId: string; deviceName: string; redactor: SecretRedactor;
    roster?(): Promise<{ devices: DeviceView[] }>; relay?(projectId: string, deviceId: string, runId: string): Promise<void>;
    now(): number; settings(projectId: string): Promise<ProjectWorkSettings>; project(projectId: string): Promise<Project>; baseBranch(repo: string): Promise<string>; event(projectId: string, event: CoordinatorEvent): Promise<void>;
    windowOpened(projectId: string): Promise<string | undefined>; day(projectId: string): Promise<string>; dayStart(projectId: string, day: string): Promise<number>; changed(): void; facts?(): DeviceFacts }) {}
  runningIds(): string[] { return [...this.#running.values()].map(row => row.id); }
  busy(projectId?: string): boolean { return projectId ? this.#running.has(projectId) || this.#starting.has(projectId) : this.#running.size > 0 || this.#starting.size > 0; }
  async mainHead(projectId: string): Promise<string> {
    const project = await this.o.project(projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName), branch = await this.o.baseBranch(repo), ref = threadBaseRef(derivedId('review_baseline', projectId));
    try {
      const head = await this.o.git.remoteUrl(repo) ? await this.o.git.fetchPrivate(repo, branch, ref) : await this.o.git.resolve(repo, `refs/heads/${branch}`);
      if (!head) throw new Error('The project has no main commit for its review baseline.'); return head;
    } finally { await this.o.git.run(repo, ['update-ref', '-d', ref]); }
  }
  async runs(projectId: string): Promise<ProjectJobRun[]> {
    const result: ProjectJobRun[] = []; let after: string | undefined;
    do { const page = await this.o.hub.jobRuns(projectId, after); result.push(...page.records); after = page.next ?? undefined; } while (after);
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }
  async #save(run: ProjectJobRun): Promise<ProjectJobRun> { return (await this.o.hub.putJobRun(ProjectJobRunSchema.parse(this.o.redactor.document(run)), run.revision)).document; }
  async #finish(run: ProjectJobRun, conclusion: NonNullable<ProjectJobRun['conclusion']>, summary: string, logTail = run.logTail): Promise<void> {
    const latest = (await this.o.hub.jobRun(run.id))?.document; if (latest?.conclusion) return this.#sync(latest);
    run = { ...run, revision: latest?.revision ?? run.revision, ...(latest?.cancelRequestedAt ? { cancelRequestedAt: latest.cancelRequestedAt } : {}) };
    const endedAt = new Date(this.o.now()).toISOString();
    const saved = await this.#save({ ...run, phase: 'finished', conclusion, endedAt, summary: this.o.redactor.text(summary).slice(0, 1200), logTail: this.o.redactor.text(logTail).slice(-8000) });
    await this.#sync(saved); this.o.changed();
  }
  async #sync(run: ProjectJobRun): Promise<void> {
    if (!run.conclusion) return;
    if ((await this.o.hub.coordinator(run.projectId))?.document.deviceId === this.o.deviceId) await this.o.tasks.exclusive(run.projectId, async () => {
      const task = await this.o.tasks.read(run.projectId, run.taskId);
      if (!['done', 'failed', 'cancelled'].includes(task.state)) await this.o.tasks.save({ ...task, jobRunId: run.id, state: run.conclusion === 'passed' ? 'done' : run.conclusion === 'cancelled' ? 'cancelled' : 'failed', endedAt: run.endedAt!, endNote: run.summary.slice(0, 400) });
    });
    const job = (await this.o.hub.job(run.jobId))?.document;
    if ((await this.o.hub.coordinator(run.projectId))?.document.deviceId === this.o.deviceId) for (const [index, finding] of (run.findings ?? []).entries()) {
      await this.o.tasks.create(run.projectId, { schema: 'task-create-request-v1', clientRequestId: derivedId('job_finding', run.id, String(index)), ...finding, type: 'finding', goalId: job?.goalId ?? null, now: false, after: [], needs: [], fixed: {} }, 'finding');
    }
    await this.o.event(run.projectId, { schema: 'coordinator-event-v1', kind: 'job-finished', id: derivedId('cev', 'job-finished', run.id), at: run.endedAt!,
      jobId: run.jobId, runId: run.id, taskId: run.taskId, name: job?.name ?? 'Job', conclusion: run.conclusion, commit: run.commit, summary: run.summary });
  }
  // Called while the queue's writer lock is held. Reserve before starting a command or GitHub mutation.
  async start(task: ProjectWorkTask): Promise<void> {
    if (this.#closed || this.busy(task.projectId) || (await this.o.settings(task.projectId)).status !== 'active') return;
    this.#starting.add(task.projectId);
    try { await this.#start(task); } finally { this.#starting.delete(task.projectId); }
  }
  async #start(task: ProjectWorkTask): Promise<void> {
    const job = task.jobId ? (await this.o.hub.job(task.jobId))?.document : null;
    if (job?.run.kind === 'github-workflow') throw Object.assign(new Error('GitHub workflow jobs retired on 19 October. Use a command job.'), { status: 409 });
    if (!job || job.projectId !== task.projectId || !job.enabled) throw Object.assign(new Error('This job is unavailable or disabled.'), { status: 409 });
    const id = derivedId('jrun', task.id); let run = (await this.o.hub.jobRun(id))?.document;
    if (!run) {
      const project = await this.o.project(task.projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName), baseBranch = await this.o.baseBranch(repo);
      const privateRef = threadBaseRef(id), remote = await this.o.git.remoteUrl(repo);
      const base = remote ? await this.o.git.fetchPrivate(repo, baseBranch, privateRef) : await this.o.git.resolve(repo, `refs/heads/${baseBranch}`);
      if (!base) throw Object.assign(new Error('The project has no published base commit for this job.'), { status: 409 });
      const window = task.nightlyWindowId ? (await this.o.hub.window(task.nightlyWindowId))?.document : null;
      const spec = job.run, gateRequired = !!job.gate;
      const day = task.projectDay ?? await this.o.day(task.projectId), gate = gateRequired ? (await this.runs(task.projectId)).find(row => row.jobId === job.gate!.jobId && row.projectDay === day && row.conclusion === 'passed' && (!window || window.taskIds.includes(row.taskId))) : undefined;
      const at = new Date(this.o.now()).toISOString();
      run = await this.#save(ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id, projectId: task.projectId, revision: 0, jobId: job.id, taskId: task.id,
        commit: gate?.commit ?? base, deviceId: this.o.deviceId, projectDay: day, startedAt: at, conclusion: null, summary: '', logTail: '', spec, baseBranch,
        phase: spec.kind === 'command' ? 'waiting' : 'reserved', requestedByDeviceId: this.o.deviceId, waitingUntil: new Date(window ? Date.parse(window.openedAt) + 7 * 3600000 : this.o.now() + 6 * 3600000).toISOString(), setupCommand: (await this.o.settings(task.projectId)).setupCommand, ...(gate ? { gateRunId: gate.id } : {}), ...(task.nightlyWindowId ? { nightlyWindowId: task.nightlyWindowId } : {}), watchAfter: await this.o.windowOpened(task.projectId) ?? new Date(await this.o.dayStart(task.projectId, day)).toISOString() }));
      if (gateRequired && !gate) await this.o.git.run(repo, ['update-ref', '-d', privateRef]);
      if (gateRequired && !gate) {
        const gateName = (await this.o.hub.job(job.gate!.jobId))?.document.name ?? 'The gate job';
        // Finish outside the queue lock, as receipt synchronization takes that lock too.
        this.#launch(run, async () => this.#finish(run!, 'skipped', `Skipped: ${gateName} has not passed today.`)); return;
      }
    }
    if (run.conclusion) return;
    if (run.spec.kind === 'command') return this.#place(run, job, task);
    await this.o.tasks.save({ ...task, state: 'active', jobRunId: id, dispatchedAt: task.dispatchedAt ?? new Date(this.o.now()).toISOString() });
    const saved = run; this.#launch(saved, controller => this.#execute(saved, job, controller.signal));
  }
  async #place(run: ProjectJobRun, job: ProjectJob, task: ProjectWorkTask): Promise<void> {
    if (run.spec.kind !== 'command') return;
    if (run.phase !== 'waiting') {
      if (run.deviceId === this.o.deviceId) await this.accept(run.id);
      else await this.o.relay?.(run.projectId, run.deviceId, run.id);
      return;
    }
    const window = run.nightlyWindowId ? (await this.o.hub.window(run.nightlyWindowId))?.document : null;
    if (run.waitingUntil && this.o.now() >= Date.parse(run.waitingUntil) || window?.state === 'finished') {
      this.#launch(run, () => this.#finish(run, 'skipped', run.nightlyWindowId ? 'No device was available before the night window ended.' : 'No device was available within 6 hours.')); return;
    }
    if ((await this.o.settings(run.projectId)).status !== 'active') return;
    const project = await this.o.project(run.projectId), threads: ThreadIndex[] = []; let after: string | undefined;
    do { const page = await this.o.hub.threads(run.projectId, after); threads.push(...page.records); after = page.next ?? undefined; } while (after);
    const roster = await this.o.roster?.(), runs = await this.runs(run.projectId);
    const devices = roster?.devices.map(view => view.device.id === this.o.deviceId && view.heartbeat ? { ...view, heartbeat: { ...view.heartbeat, facts: this.o.facts?.() ?? collectDeviceFacts(this.o.homes, [], this.runningIds()) } } : view) ?? [];
    const choice = placeCommandJob(project, run.spec.needs, devices, threads, runs, run.id);
    if (!choice.deviceId || choice.deviceId === this.o.deviceId && this.#running.size > 0) {
      const reason = choice.reason ?? `Waiting for a device with ${run.spec.needs.join(', ') || 'project access'}: ${this.o.deviceName}: another job is running.`;
      if (run.summary !== reason) run = await this.#save({ ...run, summary: reason });
      await this.o.tasks.save({ ...task, jobRunId: run.id, state: 'queued', endNote: reason.slice(0, 400) }); return;
    }
    try { run = await this.#save({ ...run, deviceId: choice.deviceId, phase: 'reserved', summary: '' }); }
    catch (error) { if ((error as { status?: number }).status === 409) return; throw error; }
    await this.o.tasks.save({ ...task, state: 'active', jobRunId: run.id, dispatchedAt: task.dispatchedAt ?? new Date(this.o.now()).toISOString() });
    if (run.deviceId === this.o.deviceId) { const saved = run; this.#launch(saved, controller => this.#execute(saved, job, controller.signal)); }
    else { if (!this.o.relay) throw new Error('Job relay is unavailable.'); await this.o.relay(run.projectId, run.deviceId, run.id); }
  }
  /** A relay carries only a receipt reference. Secrets are fetched locally from the vault at execution. */
  async accept(runId: string, sourceDeviceId?: string): Promise<void> {
    const run = (await this.o.hub.jobRun(runId))?.document;
    if (!run || run.conclusion || run.deviceId !== this.o.deviceId || run.phase === 'waiting' || this.#running.size > 0) return;
    if (run.cancelRequestedAt) return this.#finish(run, 'cancelled', 'Cancelled before execution.');
    if (sourceDeviceId && sourceDeviceId !== (run.requestedByDeviceId ?? (await this.o.hub.coordinator(run.projectId))?.document.deviceId)) throw Object.assign(new Error('Only the requesting coordinator can relay this job.'), { status: 403 });
    if (!deviceAllowsWork(this.o.homes) || deviceResourceRefusal(this.o.deviceName, this.o.facts?.() ?? collectDeviceFacts(this.o.homes))) return;
    const job = (await this.o.hub.job(run.jobId))?.document; if (!job) return;
    const project = await this.o.project(run.projectId);
    if (project.allowedDevices && !project.allowedDevices.includes(this.o.deviceId)) return;
    if (run.spec.kind === 'command' && this.o.roster) {
      const device = (await this.o.roster()).devices.find(view => view.device.id === this.o.deviceId);
      if (!device || device.revoked || device.status !== 'online' || run.spec.needs.some(tag => !device.device.tags?.includes(tag))) return;
    }
    this.#launch(run, controller => this.#execute(run, job, controller.signal));
  }
  #launch(run: ProjectJobRun, operation: (controller: AbortController) => Promise<void>): void {
    const controller = new AbortController();
    // Deferral ensures the dispatch lock is released before receipt synchronization.
    let completed = false;
    const promise = Promise.resolve().then(() => operation(controller)).then(() => { completed = true; }).catch(() => undefined).finally(() => { this.#running.delete(run.projectId); if (completed) this.o.changed(); });
    this.#running.set(run.projectId, { id: run.id, controller, promise });
  }
  async #execute(initial: ProjectJobRun, _job: ProjectJob, signal: AbortSignal): Promise<void> {
    let run = (await this.o.hub.jobRun(initial.id))?.document ?? initial;
    if (run.conclusion) return this.#sync(run);
    if (run.phase === 'reserved' && (await this.o.settings(run.projectId)).status !== 'active') return;
    if (run.phase === 'executing') { await this.#stopRecordedProcess(run); await this.#finish(run, 'failed', 'The daemon restarted during execution. The operation was not repeated. Run it again explicitly.'); return; }
    try {
      const project = await this.o.project(run.projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName);
      if (run.spec.kind === 'command') {
        const commandSpec = run.spec;
        run = await this.#save({ ...run, phase: 'executing' });
        const path = run.spec.kind === 'command' && run.spec.cwd === 'workspace' ? this.o.homes.at('project-work', run.projectId, 'job-workspaces', run.id) : this.o.homes.at('worktrees', run.projectId, 'jobs', run.id);
        if (commandSpec.cwd === 'workspace') this.o.homes.ensure('project-work', run.projectId, 'job-workspaces');
        this.o.homes.ensure('worktrees', run.projectId, 'jobs');
        if (existsSync(path)) throw new Error('A leftover job worktree needs cleanup before retry.');
        let added = false; let outcome: { conclusion: NonNullable<ProjectJobRun['conclusion']>; summary: string; logTail: string } | undefined;
        try {
          // Fetch the exact gate commit without moving origin/base or the registered checkout.
          if (!await this.o.git.resolve(repo, run.commit)) await this.o.git.run(repo, ['fetch', '--refmap=', '--no-write-fetch-head', '--no-tags', 'origin', run.commit]);
          await this.o.git.run(repo, ['worktree', 'add', '--detach', path, run.commit]); added = true;
          const setupCommand = run.setupCommand;
          const onProcess = (native: NativeProcess) => { writeDocument(this.#processPath(run), JobProcessSchema, { ...native, schema: 'project-job-process-v1', turn: 1, startedAt: new Date(this.o.now()).toISOString() }); };
          const setup = setupCommand ? await runThreadCommand(path, setupCommand, { homes: this.o.homes, workId: run.id, timeoutMs: SETUP_TIMEOUT_MS, redactor: this.o.redactor, projectEnv: await this.o.projectEnvironment?.(run.projectId) ?? {}, signal, minimal: true, environmentScope: 'command', jobContext: { schema: 'project-job-context-v1', runId: run.id, projectId: run.projectId, jobId: run.jobId, commit: run.commit }, onProcess }) : null;
          if (setup && (setup.timedOut || setup.code !== 0)) outcome = { conclusion: setup.timedOut ? 'timed-out' : 'failed', summary: 'The project setup command failed.', logTail: outputTail(setup, 8000) };
          else { const result = await runThreadCommand(path, commandSpec.command, { homes: this.o.homes, workId: run.id, timeoutMs: commandSpec.timeoutMinutes * 60_000, redactor: this.o.redactor, projectEnv: await this.o.projectEnvironment?.(run.projectId) ?? {}, signal, minimal: true, environmentScope: 'command', jobContext: { schema: 'project-job-context-v1', runId: run.id, projectId: run.projectId, jobId: run.jobId, commit: run.commit }, onProcess });
          outcome = { conclusion: signal.aborted ? 'cancelled' : result.timedOut ? 'timed-out' : result.code === 0 ? 'passed' : 'failed', summary: result.code === 0 ? 'Command passed.' : result.timedOut ? 'Command timed out.' : `Command exited with ${result.code}.`, logTail: outputTail(result, 8000) }; }
          const findingsFile = join(path, 'project-job-findings.json');
          if (existsSync(findingsFile)) run = { ...run, findings: ProjectJobFindingsSchema.parse(this.o.redactor.document(readDocument(findingsFile, ProjectJobFindingsSchema))).findings };
        } finally {
          await this.#stopRecordedProcess(run);
          if (added && commandSpec.cwd !== 'workspace') await this.o.git.run(repo, ['worktree', 'remove', '--force', path]);
          await this.o.git.run(repo, ['update-ref', '-d', threadBaseRef(run.id)]).catch(() => undefined);
        }
        if (!outcome) throw new Error('The command has no recorded outcome.');
        await this.#finish(commandSpec.cwd === 'workspace' ? { ...run, workspaceRetainedAt: new Date(this.o.now()).toISOString() } : run, outcome.conclusion, outcome.summary, outcome.logTail);
      }
    } catch (error) {
      run = (await this.o.hub.jobRun(run.id))?.document ?? run;
      if (!run.conclusion) await this.#finish(run, signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'Job execution failed.');
    }
  }
  async sweep(projectId: string): Promise<void> {
    if (this.#closed || !deviceAllowsWork(this.o.homes)) return;
    const active = this.#running.get(projectId);
    if (active) { if ((await this.o.hub.jobRun(active.id))?.document.cancelRequestedAt) active.controller.abort(); return; }
    if (this.#starting.has(projectId)) return;
    this.#starting.add(projectId);
    try { await this.#sweep(projectId); } finally { this.#starting.delete(projectId); }
  }
  async #sweep(projectId: string): Promise<void> {
    await this.cleanup(projectId);
    for (const run of await this.runs(projectId)) {
      if (run.conclusion) { await this.#sync(run); continue; }
      if (run.spec.kind === 'github-workflow') { await this.#finish(run, 'skipped', 'GitHub workflow (retired 19 October)'); continue; }
      if (run.phase === 'waiting' && (await this.o.hub.coordinator(projectId))?.document.deviceId === this.o.deviceId) { const job = (await this.o.hub.job(run.jobId))?.document; if (job) await this.#place(run, job, await this.o.tasks.read(projectId, run.taskId)); continue; }
      if (run.deviceId !== this.o.deviceId) { if (run.phase === 'reserved' && (await this.o.hub.coordinator(projectId))?.document.deviceId === this.o.deviceId) await this.o.relay?.(projectId, run.deviceId, run.id); continue; }
      if (run.phase === 'waiting' || this.#running.size > 0) continue;
      if (run.pollAfter && Date.parse(run.pollAfter) > this.o.now()) continue;
      if (run.phase === 'reserved' && (await this.o.settings(projectId)).status !== 'active') continue;
      const task = await this.o.tasks.read(projectId, run.taskId);
      if (task.state === 'cancelled') { await this.#finish(run, 'cancelled', 'Cancelled before execution.'); continue; }
      const job = (await this.o.hub.job(run.jobId))?.document;
      if (!job) { await this.#finish(run, 'failed', 'The job definition is unavailable.'); continue; }
      await this.accept(run.id); if (this.busy()) break;
    }
  }
  async cancel(projectId: string): Promise<void> {
    this.#running.get(projectId)?.controller.abort();
    for (const run of await this.runs(projectId)) if (!run.conclusion && run.phase !== 'waiting' && !run.cancelRequestedAt) await this.#save({ ...run, cancelRequestedAt: new Date(this.o.now()).toISOString() });
  }
  #processPath(run: ProjectJobRun): string { return join(this.o.homes.ensure('project-work', run.projectId, 'job-processes'), `${run.id}.json`); }
  async #stopRecordedProcess(run: ProjectJobRun): Promise<void> {
    const path = this.#processPath(run); if (!existsSync(path)) return;
    await endTurnProcess(readDocument(path, JobProcessSchema)); rmSync(path);
  }
  async cleanup(projectId: string): Promise<void> {
    const runs = (await this.runs(projectId)).filter(run => run.conclusion && run.deviceId === this.o.deviceId && (!run.cleanedAt || existsSync(this.#processPath(run)))); if (!runs.length) return;
    const project = await this.o.project(projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName);
    const entries = parseWorktrees((await this.o.git.run(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout);
    for (const run of runs) {
      await this.#stopRecordedProcess(run);
      const path = this.o.homes.at('worktrees', projectId, 'jobs', run.id);
      if (entries.some(row => row.path === path)) { if (!existsSync(path)) rmSync(path, { recursive: true, force: true }); await this.o.git.run(repo, ['worktree', 'remove', '--force', path]); }
      await this.o.git.run(repo, ['update-ref', '-d', threadBaseRef(run.id)]);
      const latest = (await this.o.hub.jobRun(run.id))?.document;
      if (latest?.conclusion && latest.deviceId === this.o.deviceId && !latest.cleanedAt) await this.#save({ ...latest, cleanedAt: new Date(this.o.now()).toISOString() });
    }
  }
  async close(): Promise<void> { this.#closed = true; for (const row of this.#running.values()) row.controller.abort(); await Promise.allSettled([...this.#running.values()].map(row => row.promise)); }
}
