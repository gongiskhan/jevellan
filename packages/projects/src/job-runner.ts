import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deviceAllowsWork, parseGitHubRemote, ProjectJobRunSchema, resolveProjectPath, type CoordinatorEvent, type Homes, type Project, type ProjectHub, type ProjectJob, type ProjectJobRun, type ProjectWorkTask, type ProjectWorkSettings, type SecretRedactor } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import { ThreadGit, threadBaseRef } from './git.js';
import type { GitHubAccess } from './publication.js';
import type { ProjectTasks } from './tasks.js';
import { outputTail, runThreadCommand, SETUP_TIMEOUT_MS } from './verification.js';
import { parseWorktrees } from './worktree.js';
import { readDocument, writeDocument, TurnProcessSchema, type NativeProcess } from '@jevellan/core';
import { z } from 'zod';
import { endTurnProcess } from './recovery.js';
const JobProcessSchema = TurnProcessSchema.extend({ schema: z.literal('project-job-process-v1') });

export class ProjectJobRunner {
  readonly #running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly #starting = new Set<string>();
  #closed = false;
  constructor(readonly o: { homes: Homes; hub: ProjectHub; tasks: ProjectTasks; git: ThreadGit; github: GitHubAccess; deviceId: string; deviceName: string; redactor: SecretRedactor;
    now(): number; settings(projectId: string): Promise<ProjectWorkSettings>; project(projectId: string): Promise<Project>; baseBranch(repo: string): Promise<string>; event(projectId: string, event: CoordinatorEvent): Promise<void>;
    windowOpened(projectId: string): Promise<string | undefined>; day(projectId: string): Promise<string>; dayStart(projectId: string, day: string): Promise<number>; changed(): void }) {}
  busy(projectId?: string): boolean { return projectId ? this.#running.has(projectId) || this.#starting.has(projectId) : this.#running.size > 0 || this.#starting.size > 0; }
  async runs(projectId: string): Promise<ProjectJobRun[]> {
    const result: ProjectJobRun[] = []; let after: string | undefined;
    do { const page = await this.o.hub.jobRuns(projectId, after); result.push(...page.records); after = page.next ?? undefined; } while (after);
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }
  async #save(run: ProjectJobRun): Promise<ProjectJobRun> { return (await this.o.hub.putJobRun(ProjectJobRunSchema.parse(this.o.redactor.document(run)), run.revision)).document; }
  async #finish(run: ProjectJobRun, conclusion: NonNullable<ProjectJobRun['conclusion']>, summary: string, logTail = run.logTail): Promise<void> {
    const endedAt = new Date(this.o.now()).toISOString();
    const saved = await this.#save({ ...run, phase: 'finished', conclusion, endedAt, summary: this.o.redactor.text(summary).slice(0, 1200), logTail: this.o.redactor.text(logTail).slice(-8000) });
    await this.#sync(saved); this.o.changed();
  }
  async #sync(run: ProjectJobRun): Promise<void> {
    if (!run.conclusion) return;
    await this.o.tasks.exclusive(run.projectId, async () => {
      const task = await this.o.tasks.read(run.projectId, run.taskId);
      if (!['done', 'failed', 'cancelled'].includes(task.state)) await this.o.tasks.save({ ...task, jobRunId: run.id, state: run.conclusion === 'passed' ? 'done' : run.conclusion === 'cancelled' ? 'cancelled' : 'failed', endedAt: run.endedAt!, endNote: run.summary.slice(0, 400) });
    });
    const job = (await this.o.hub.job(run.jobId))?.document;
    await this.o.event(run.projectId, { schema: 'coordinator-event-v1', kind: 'job-finished', id: derivedId('cev', 'job-finished', run.id), at: run.endedAt!,
      jobId: run.jobId, runId: run.id, taskId: run.taskId, name: job?.name ?? 'Job', conclusion: run.conclusion, commit: run.commit, summary: run.summary });
  }
  // Called while the queue's writer lock is held. Reserve before starting a command or GitHub mutation.
  async start(task: ProjectWorkTask): Promise<void> {
    if (this.#closed || this.busy(task.projectId)) return;
    this.#starting.add(task.projectId);
    try { await this.#start(task); } finally { this.#starting.delete(task.projectId); }
  }
  async #start(task: ProjectWorkTask): Promise<void> {
    if (!deviceAllowsWork(this.o.homes)) throw Object.assign(new Error('This device serves apps only; project work runs on a working device.'), { status: 409 });
    const job = task.jobId ? (await this.o.hub.job(task.jobId))?.document : null;
    if (!job || job.projectId !== task.projectId || !job.enabled) throw Object.assign(new Error('This job is unavailable or disabled.'), { status: 409 });
    const id = derivedId('jrun', task.id); let run = (await this.o.hub.jobRun(id))?.document;
    if (!run) {
      const project = await this.o.project(task.projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName), baseBranch = await this.o.baseBranch(repo);
      const privateRef = threadBaseRef(id), remote = await this.o.git.remoteUrl(repo);
      const base = remote ? await this.o.git.fetchPrivate(repo, baseBranch, privateRef) : await this.o.git.resolve(repo, `refs/heads/${baseBranch}`);
      if (!base) throw Object.assign(new Error('The project has no published base commit for this job.'), { status: 409 });
      const day = task.projectDay ?? await this.o.day(task.projectId), gate = job.gate ? (await this.runs(task.projectId)).find(row => row.jobId === job.gate!.jobId && row.projectDay === day && row.conclusion === 'passed') : undefined;
      const at = new Date(this.o.now()).toISOString();
      run = await this.#save(ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id, projectId: task.projectId, revision: 0, jobId: job.id, taskId: task.id,
        commit: gate?.commit ?? base, deviceId: this.o.deviceId, projectDay: day, startedAt: at, conclusion: null, summary: '', logTail: '', spec: job.run, baseBranch,
        phase: 'reserved', setupCommand: (await this.o.settings(task.projectId)).setupCommand, ...(gate ? { gateRunId: gate.id } : {}), watchAfter: await this.o.windowOpened(task.projectId) ?? new Date(await this.o.dayStart(task.projectId, day)).toISOString() }));
      if (job.run.kind === 'github-workflow' || job.gate && !gate) await this.o.git.run(repo, ['update-ref', '-d', privateRef]);
      if (job.gate && !gate) {
        const gateName = (await this.o.hub.job(job.gate.jobId))?.document.name ?? 'The gate job';
        // Finish outside the queue lock, as receipt synchronization takes that lock too.
        this.#launch(run, async () => this.#finish(run!, 'skipped', `Skipped: ${gateName} has not passed today.`)); return;
      }
    }
    await this.o.tasks.save({ ...task, state: 'active', jobRunId: id, dispatchedAt: task.dispatchedAt ?? new Date(this.o.now()).toISOString() });
    const saved = run; this.#launch(saved, controller => this.#execute(saved, job, controller.signal));
  }
  #launch(run: ProjectJobRun, operation: (controller: AbortController) => Promise<void>): void {
    const controller = new AbortController();
    // Deferral ensures the dispatch lock is released before receipt synchronization.
    let completed = false;
    const promise = Promise.resolve().then(() => operation(controller)).then(() => { completed = true; }).catch(() => undefined).finally(() => { this.#running.delete(run.projectId); if (completed) this.o.changed(); });
    this.#running.set(run.projectId, { controller, promise });
  }
  async #execute(initial: ProjectJobRun, _job: ProjectJob, signal: AbortSignal): Promise<void> {
    let run = (await this.o.hub.jobRun(initial.id))?.document ?? initial;
    if (run.conclusion) return this.#sync(run);
    if (run.phase === 'executing') { await this.#stopRecordedProcess(run); await this.#finish(run, 'failed', 'The daemon restarted during execution. The operation was not repeated. Run it again explicitly.'); return; }
    try {
      const project = await this.o.project(run.projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName);
      if (run.spec.kind === 'command') {
        const commandSpec = run.spec;
        run = await this.#save({ ...run, phase: 'executing' });
        const path = this.o.homes.at('worktrees', run.projectId, 'jobs', run.id);
        if (path !== join(this.o.homes.root, 'worktrees', run.projectId, 'jobs', run.id)) throw new Error('Job worktrees cannot alias another location.');
        this.o.homes.ensure('worktrees', run.projectId, 'jobs');
        if (existsSync(path)) throw new Error('A leftover job worktree needs cleanup before retry.');
        let added = false; let outcome: { conclusion: NonNullable<ProjectJobRun['conclusion']>; summary: string; logTail: string } | undefined;
        try {
          // Fetch the exact gate commit without moving origin/base or the registered checkout.
          if (!await this.o.git.resolve(repo, run.commit)) await this.o.git.run(repo, ['fetch', '--refmap=', '--no-write-fetch-head', '--no-tags', 'origin', run.commit]);
          await this.o.git.run(repo, ['worktree', 'add', '--detach', path, run.commit]); added = true;
          const setupCommand = run.setupCommand;
          const onProcess = (native: NativeProcess) => { writeDocument(this.#processPath(run), JobProcessSchema, { ...native, schema: 'project-job-process-v1', turn: 1, startedAt: new Date(this.o.now()).toISOString() }); };
          const setup = setupCommand ? await runThreadCommand(path, setupCommand, { homes: this.o.homes, workId: run.id, timeoutMs: SETUP_TIMEOUT_MS, redactor: this.o.redactor, signal, minimal: true, onProcess }) : null;
          if (setup && (setup.timedOut || setup.code !== 0)) outcome = { conclusion: setup.timedOut ? 'timed-out' : 'failed', summary: 'The project setup command failed.', logTail: outputTail(setup, 8000) };
          else { const result = await runThreadCommand(path, commandSpec.command, { homes: this.o.homes, workId: run.id, timeoutMs: commandSpec.timeoutMinutes * 60_000, redactor: this.o.redactor, signal, minimal: true, onProcess });
          outcome = { conclusion: signal.aborted ? 'cancelled' : result.timedOut ? 'timed-out' : result.code === 0 ? 'passed' : 'failed', summary: result.code === 0 ? 'Command passed.' : result.timedOut ? 'Command timed out.' : `Command exited with ${result.code}.`, logTail: outputTail(result, 8000) }; }
        } finally {
          await this.#stopRecordedProcess(run);
          if (added) await this.o.git.run(repo, ['worktree', 'remove', '--force', path]);
          await this.o.git.run(repo, ['update-ref', '-d', threadBaseRef(run.id)]).catch(() => undefined);
        }
        if (!outcome) throw new Error('The command has no recorded outcome.');
        await this.#finish(run, outcome.conclusion, outcome.summary, outcome.logTail);
      } else {
        const repository = parseGitHubRemote(await this.o.git.remoteUrl(repo) ?? ''); if (!repository) throw new Error('This project does not have a GitHub remote.');
        const workflowSpec = run.spec;
        const client = await this.o.github.open();
        if (run.phase === 'reserved' && run.spec.mode === 'dispatch') {
          // Crash after this write refuses re-dispatch rather than risking duplicate workflow effects.
          run = await this.#save({ ...run, phase: 'executing' });
          const ref = run.gateRunId ? `jv/jobs/${run.id}` : run.baseBranch;
          if (run.gateRunId) await client.pinWorkflowRef(repository, ref, run.commit);
          const dispatched = await client.dispatchWorkflow(repository, workflowSpec.workflow, ref);
          run = await this.#save({ ...run, phase: 'watching', workflowRunId: dispatched.workflow_run_id, url: dispatched.html_url, dispatchRef: ref });
        } else if (run.phase === 'reserved') run = await this.#save({ ...run, phase: 'watching' });
        if (run.pollAfter && Date.parse(run.pollAfter) > this.o.now()) return;
        const spec = run.spec; if (spec.kind !== 'github-workflow') throw new Error('Invalid workflow receipt.');
        const actual = run.workflowRunId ? await client.workflowRun(repository, run.workflowRunId) : (await client.workflowRuns(repository, spec.workflow, run.baseBranch, run.watchAfter))
          .filter(row => Date.parse(row.run_started_at ?? row.created_at) >= Date.parse(run.watchAfter) && (!run.gateRunId || row.head_sha === run.commit))
          .sort((a, b) => (b.run_started_at ?? b.created_at).localeCompare(a.run_started_at ?? a.created_at) || b.id - a.id)[0];
        if (actual && (!run.workflowRunId || !run.workflowHeadBound && !run.gateRunId)) run = await this.#save({ ...run, workflowRunId: actual.id, url: actual.html_url, commit: actual.head_sha, workflowHeadBound: true });
        if (actual && (actual.id !== run.workflowRunId || actual.head_sha !== run.commit)) { await this.#finish(run, 'failed', 'The workflow run does not match its recorded commit.'); return; }
        if (actual?.status === 'completed') {
          const jobs = await client.workflowJobs(repository, actual.id), failed = jobs.filter(row => row.conclusion && !['success', 'skipped', 'neutral'].includes(row.conclusion));
          const required = (spec.requiredJobs ?? []).every(name => jobs.some(row => row.name === name && row.status === 'completed' && row.conclusion === 'success'))
            && (spec.requiredSteps ?? []).every(name => jobs.some(row => row.steps?.some(step => step.name === name && step.status === 'completed' && step.conclusion === 'success')));
          let logs = '';
          for (const row of failed) { try { logs += `${row.name}\n${await client.workflowJobLog(repository, row.id)}\n`; } catch { logs += 'Logs not readable with this token.\n'; } }
          await this.#finish(run, actual.conclusion === 'success' && required ? 'passed' : actual.conclusion === 'cancelled' ? 'cancelled' : actual.conclusion === 'timed_out' ? 'timed-out' : 'failed',
            failed.length ? `Failed jobs: ${failed.map(row => row.name).join(', ')}.${!required ? ' The required test jobs or steps did not run successfully.' : ''}` : !required ? 'The required test jobs or steps did not run successfully.' : `Workflow ${actual.conclusion ?? 'completed'}.`, logs); return;
        }
        if (this.o.now() - Date.parse(run.startedAt) >= spec.timeoutMinutes * 60_000) { await this.#finish(run, 'timed-out', actual ? 'The workflow did not finish in time.' : `No run of ${spec.workflow} started today.`); return; }
        await this.#save({ ...run, pollAfter: new Date(this.o.now() + 60_000).toISOString() });
      }
    } catch (error) {
      run = (await this.o.hub.jobRun(run.id))?.document ?? run;
      if (!run.conclusion) await this.#finish(run, signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'Job execution failed.');
    }
  }
  async sweep(projectId: string): Promise<void> {
    if (this.#closed || this.busy(projectId) || !deviceAllowsWork(this.o.homes)) return;
    this.#starting.add(projectId);
    try { await this.#sweep(projectId); } finally { this.#starting.delete(projectId); }
  }
  async #sweep(projectId: string): Promise<void> {
    await this.cleanup(projectId);
    for (const run of await this.runs(projectId)) {
      if (run.conclusion) { await this.#sync(run); continue; }
      if (run.deviceId !== this.o.deviceId) { await this.#finish(run, 'failed', 'The coordinator device changed during this job. It was not repeated.'); continue; }
      if (run.pollAfter && Date.parse(run.pollAfter) > this.o.now()) continue;
      const task = await this.o.tasks.read(projectId, run.taskId);
      if (task.state === 'cancelled') { await this.#finish(run, 'cancelled', 'Cancelled before execution.'); continue; }
      const job = (await this.o.hub.job(run.jobId))?.document;
      if (!job) { await this.#finish(run, 'failed', 'The job definition is unavailable.'); continue; }
      this.#launch(run, controller => this.#execute(run, job, controller.signal)); break;
    }
  }
  cancel(projectId: string): void { this.#running.get(projectId)?.controller.abort(); }
  #processPath(run: ProjectJobRun): string { return join(this.o.homes.ensure('project-work', run.projectId, 'job-processes'), `${run.id}.json`); }
  async #stopRecordedProcess(run: ProjectJobRun): Promise<void> {
    const path = this.#processPath(run); if (!existsSync(path)) return;
    await endTurnProcess(readDocument(path, JobProcessSchema)); rmSync(path);
  }
  async cleanup(projectId: string): Promise<void> {
    const runs = (await this.runs(projectId)).filter(run => run.conclusion && run.deviceId === this.o.deviceId); if (!runs.length) return;
    const project = await this.o.project(projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName);
    const entries = parseWorktrees((await this.o.git.run(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout);
    for (const run of runs) {
      await this.#stopRecordedProcess(run);
      const path = this.o.homes.at('worktrees', projectId, 'jobs', run.id);
      if (entries.some(row => row.path === path)) { if (!existsSync(path)) rmSync(path, { recursive: true, force: true }); await this.o.git.run(repo, ['worktree', 'remove', '--force', path]); }
      await this.o.git.run(repo, ['update-ref', '-d', threadBaseRef(run.id)]);
    }
  }
  async close(): Promise<void> { this.#closed = true; for (const row of this.#running.values()) row.controller.abort(); await Promise.allSettled([...this.#running.values()].map(row => row.promise)); }
}
