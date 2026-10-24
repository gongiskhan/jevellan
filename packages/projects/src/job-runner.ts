import type { ProjectEnvSecretSummary } from '@jevellan/core';
import {ProjectIntake} from './intake.js';
import {ProjectIntakeLanding} from './intake-landing.js';
import {ProjectWorkTaskSchema,stableJson,type IntakeAction,type IntakeCheck,type PublicationLeaseService} from '@jevellan/core';
import { importJobDeliveries, LegalLandingReceiptsSchema } from './job-deliveries.js';
import { placeCommandJob } from './job-placement.js';
import type { DeviceView, ThreadIndex } from '@jevellan/core';
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deviceAllowsWork, ProjectDeployJobResultSchema, ProjectJobFindingsSchema, ProjectJobRunSchema, resolveProjectPath, type CoordinatorEvent, type Homes, type Project, type ProjectHub, type ProjectJob, type ProjectJobRun, type ProjectWorkTask, type ProjectWorkSettings, type SecretRedactor } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import { ThreadGit, threadBaseRef } from './git.js';
import type { GitHubAccess } from './publication.js';
import {taskRankBetween,type ProjectTasks} from './tasks.js';
import { outputTail, runThreadCommand, SETUP_TIMEOUT_MS } from './verification.js';
import { parseWorktrees } from './worktree.js';
import { readDocument, writeDocument, TurnProcessSchema, type NativeProcess } from '@jevellan/core';
import { z } from 'zod';
import { collectDeviceFacts, deviceResourceRefusal, type DeviceFacts } from '@jevellan/core';
import { endTurnProcess } from './recovery.js';
const JobProcessSchema = TurnProcessSchema.extend({ schema: z.literal('project-job-process-v1') });

export class ProjectJobRunner {
  readonly intake:ProjectIntake;
  readonly intakeLanding:ProjectIntakeLanding;
  readonly #running = new Map<string, { id: string; controller: AbortController; promise: Promise<void> }>();
  readonly #starting = new Set<string>();
  #closed = false;
  constructor(readonly o: { leases?:PublicationLeaseService|undefined;assertIntakeLanding?(projectId:string):Promise<void>;library?: import('@jevellan/core').ProjectLibrary | undefined; beforeDeployment?(run: ProjectJobRun): Promise<void>; projectEnvironment?(projectId: string): Promise<Record<string, string>>; checkCredentials?(projectId: string): Promise<Record<string, string>>; checkSecretSummary?(projectId: string,name: string): Promise<ProjectEnvSecretSummary>; homes: Homes; hub: ProjectHub; tasks: ProjectTasks; git: ThreadGit; github: GitHubAccess; deviceId: string; deviceName: string; redactor: SecretRedactor;
    roster?(): Promise<{ devices: DeviceView[] }>; relay?(projectId: string, deviceId: string, runId: string): Promise<void>;
    now(): number; settings(projectId: string): Promise<ProjectWorkSettings>; project(projectId: string): Promise<Project>; baseBranch(repo: string): Promise<string>; event(projectId: string, event: CoordinatorEvent): Promise<void>;
    windowOpened(projectId: string): Promise<string | undefined>; day(projectId: string): Promise<string>; dayStart(projectId: string, day: string): Promise<number>; changed(): void; facts?(): DeviceFacts }) {this.intake=new ProjectIntake(o);this.intakeLanding=new ProjectIntakeLanding(o);}
  runningIds(): string[] { return [...this.#running.values()].map(row => row.id); }
  async prepareIntakeLanding(check:IntakeCheck):Promise<void>{
    if(!this.o.leases)throw Object.assign(Error('The publication lease service is unavailable.'),{status:409});
    await this.o.assertIntakeLanding?.(check.projectId);
    const checked=(await this.o.hub.jobRun(check.runId))?.document,job=checked&&(await this.o.hub.job(checked.jobId))?.document;
    if(!checked?.conclusion||checked.projectId!==check.projectId||checked.spec.kind!=='command'||!checked.spec.intake||!job||job.projectId!==check.projectId||!job.enabled||job.paused||job.run.kind!=='command'||!job.run.intake)throw Object.assign(Error('The checked intake job is unavailable or changed.'),{status:409});
  }
  async queueIntakeLanding(action:IntakeAction,check:IntakeCheck):Promise<void>{
    await this.prepareIntakeLanding(check);
    await this.o.tasks.exclusive(check.projectId,async()=>{
      await this.o.tasks.assertWriter(check.projectId);
      const stored=(await this.o.hub.intakeDocument(action.id))?.document,decision=(await this.o.hub.decision(action.decisionId))?.document;
      if(stored?.schema!=='intake-action-v1'||stored.checkId!==check.id||stored.answer.optionLabel!=='merge'||!stored.taskId||decision?.answer?.optionLabel!=='merge')throw Object.assign(Error('This landing has no matching owner approval.'),{status:403});
      const binding={schema:'intake-landing-binding-v1' as const,actionId:stored.id,checkId:check.id},previous=(await this.o.hub.task(stored.taskId))?.document;
      if(previous){if(stableJson(previous.intakeLanding)!==stableJson(binding))throw Error('This landing task belongs to another approval.');return;}
      const source=(await this.o.hub.jobRun(check.runId))!.document,ordered=await this.o.tasks.list(check.projectId),at=new Date(this.o.now()).toISOString();
      await this.o.tasks.save(ProjectWorkTaskSchema.parse({schema:'project-work-task-v1',id:stored.taskId,projectId:check.projectId,revision:0,title:`Land PR #${check.pull.number}: ${check.pull.title}`.slice(0,120),brief:`Land the owner-approved checked head ${check.pull.headSha} from ${check.pull.url}.`,kind:'job',type:'feature',goalId:null,source:'owner',state:'queued',rank:taskRankBetween(ordered.map(row=>row.rank).sort().at(-1)??null,null),ownerRanked:false,now:false,after:[],needs:[],dailyId:null,jobId:source.jobId,threadId:null,jobRunId:null,fixed:{},intakeLanding:binding,createdAt:at,updatedAt:at}));
    });this.o.changed();
  }
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
      const idleIntake=run.conclusion==='skipped'&&run.spec.kind==='command'&&!!run.spec.intake&&!!run.intake&&run.intake.errors.length===0&&run.intake.pulls.length===0;
      if (!['done', 'failed', 'cancelled'].includes(task.state)) await this.o.tasks.save({ ...task, jobRunId: run.id, state: run.conclusion === 'passed'||idleIntake ? 'done' : run.conclusion === 'cancelled' ? 'cancelled' : 'failed', endedAt: run.endedAt!, endNote: run.summary.slice(0, 400) });
    });
    const job = (await this.o.hub.job(run.jobId))?.document;
    if ((await this.o.hub.coordinator(run.projectId))?.document.deviceId === this.o.deviceId) for (const [index, finding] of (run.findings ?? []).entries()) {
      await this.o.tasks.create(run.projectId, { schema: 'task-create-request-v1', clientRequestId: derivedId('job_finding', run.id, String(index)), ...finding, type: 'finding', goalId: job?.goalId ?? null, now: false, after: [], needs: [], fixed: {} }, 'finding');
    }
    if ((await this.o.hub.coordinator(run.projectId))?.document.deviceId === this.o.deviceId) for (const delivery of run.deliveries ?? []) {
      await this.o.tasks.create(run.projectId, { schema: 'task-create-request-v1', clientRequestId: derivedId('job_delivery', run.id, delivery.id), title: delivery.title, brief: delivery.brief, fromBranch: delivery.fromBranch, type: delivery.type, goalId: job?.goalId ?? null, now: false, after: [], needs: [], fixed: delivery.gate ? { deviceId: run.deviceId } : {} }, 'finding', { jobDelivery: { runId: run.id, deliveryId: delivery.id } });
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
    let intakeSpec:ProjectJobRun['spec']|undefined;
    if(task.intakeLanding){const check=(await this.o.hub.intakeDocument(task.intakeLanding.checkId))?.document;if(check?.schema!=='intake-check-v1')throw Error('The intake check is unavailable.');await this.prepareIntakeLanding(check);intakeSpec=(await this.o.hub.jobRun(check.runId))!.document.spec;}
    const deploySettings = (await this.o.settings(task.projectId)).deploy;
    if ((job.id === deploySettings.jobId || job.id === deploySettings.desktopJobId) && !task.deployment) throw Object.assign(new Error('Deploy jobs run only from the owner’s deploy message.'), { status: 403 });
    if (task.deployment) {
      const deploy = (await this.o.hub.deploy(task.deployment.deployId))?.document;
      const permitted = deploy?.projectId === task.projectId && (task.deployment.mode === 'rollback' ? deploy.rollbackPending?.taskId === task.id && deploy.previousCommit === task.deployment.commit : task.deployment.mode === 'desktop' ? deploy.desktopTaskId === task.id && deploy.commit === task.deployment.commit : ['approved', 'running'].includes(deploy.state) && deploy.jobTaskId === task.id && deploy.commit === task.deployment.commit);
      if (!permitted) throw Object.assign(new Error('This job has no matching owner-approved deploy.'), { status: 403 });
    }
    const id = derivedId('jrun', task.id); let run = (await this.o.hub.jobRun(id))?.document;
    if (!run) {
      const project = await this.o.project(task.projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName), baseBranch = await this.o.baseBranch(repo);
      const privateRef = threadBaseRef(id), remote = await this.o.git.remoteUrl(repo);
      const base = remote ? await this.o.git.fetchPrivate(repo, baseBranch, privateRef) : await this.o.git.resolve(repo, `refs/heads/${baseBranch}`);
      if (!base) throw Object.assign(new Error('The project has no published base commit for this job.'), { status: 409 });
      if (task.deployment && (await this.o.git.run(repo, ['merge-base', '--is-ancestor', task.deployment.commit, base], { permitted: [1, 128] })).code !== 0) throw Object.assign(new Error(`Commit ${task.deployment.commit} is not on origin/main. Deploys build only from main.`), { status: 409 });
      const window = task.nightlyWindowId ? (await this.o.hub.window(task.nightlyWindowId))?.document : null;
      const spec = intakeSpec??job.run, gateRequired = !!job.gate;
      const day = task.projectDay ?? await this.o.day(task.projectId), gate = gateRequired ? (await this.runs(task.projectId)).find(row => row.jobId === job.gate!.jobId && row.projectDay === day && row.conclusion === 'passed' && (!window || window.taskIds.includes(row.taskId))) : undefined;
      const at = new Date(this.o.now()).toISOString();
      run = await this.#save(ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id, projectId: task.projectId, revision: 0, jobId: job.id, taskId: task.id,
        commit: task.deployment?.commit ?? gate?.commit ?? base, ...(task.deployment ? { deployment: task.deployment } : {}),...(task.intakeLanding?{intakeLanding:task.intakeLanding}:{}), deviceId: this.o.deviceId, projectDay: day, startedAt: at, conclusion: null, summary: '', logTail: '', spec, baseBranch,
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
    if (task.state === 'cancelled' || run.cancelRequestedAt) { this.#launch(run, () => this.#finish(run, 'cancelled', 'Cancelled before execution.')); return; }
    if (run.phase !== 'waiting') { this.#begin(run, job); return; }
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
    this.#begin(run, job);
  }
  #begin(run: ProjectJobRun, job: ProjectJob): void {
    this.#launch(run, async controller => {
      if (run.deployment?.mode === 'deploy') await this.o.beforeDeployment?.(run);
      if (run.deviceId === this.o.deviceId) await this.#execute(run, job, controller.signal);
      else { if (!this.o.relay) throw new Error('Job relay is unavailable.'); await this.o.relay(run.projectId, run.deviceId, run.id); }
    }, run.deviceId === this.o.deviceId);
  }
  /** A relay carries only a receipt reference. Secrets are fetched locally from the vault at execution. */
  async accept(runId: string, sourceDeviceId?: string): Promise<void> {
    const run = (await this.o.hub.jobRun(runId))?.document;
    if (!run || run.conclusion || run.deviceId !== this.o.deviceId || run.phase === 'waiting' || this.#running.size > 0) return;
    if (run.cancelRequestedAt) return this.#finish(run, 'cancelled', 'Cancelled before execution.');
    if (sourceDeviceId && sourceDeviceId !== run.requestedByDeviceId && sourceDeviceId !== (await this.o.hub.coordinator(run.projectId))?.document.deviceId) throw Object.assign(new Error('Only the requesting coordinator can relay this job.'), { status: 403 });
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
  #launch(run: ProjectJobRun, operation: (controller: AbortController) => Promise<void>, notify = true): void {
    const controller = new AbortController();
    // Deferral ensures the dispatch lock is released before receipt synchronization.
    let completed = false;
    const promise = Promise.resolve().then(() => operation(controller)).then(() => { completed = true; }).catch(() => undefined).finally(() => { this.#running.delete(run.projectId); if (completed && notify) this.o.changed(); });
    this.#running.set(run.projectId, { id: run.id, controller, promise });
  }
  async #execute(initial: ProjectJobRun, _job: ProjectJob, signal: AbortSignal): Promise<void> {
    let run = (await this.o.hub.jobRun(initial.id))?.document ?? initial;let intakeTimedOut=false;
    if (run.conclusion) return this.#sync(run);
    if (run.deployment?.mode === 'deploy' && (await this.o.hub.deploy(run.deployment.deployId))?.document.healthBeforeJobRunId !== run.id) return;
    if (run.phase === 'reserved' && (await this.o.settings(run.projectId)).status !== 'active') return;
    if (run.phase === 'executing') { await this.#stopRecordedProcess(run);if(run.intakeLanding){const recovered=await this.intakeLanding.recover(run);await this.#finish(run,recovered?.conclusion??'failed',recovered?.summary??'The interrupted intake landing has no candidate receipt. No operation was repeated.');return;} run = await this.#recoverDeliveries(run); await this.#finish(run, 'failed', 'The daemon restarted during execution. The operation was not repeated. Run it again explicitly.'); return; }
    try {
      const project = await this.o.project(run.projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName);
      if (run.spec.kind === 'command') {
        if(run.spec.intake){
          if(run.deployment)throw Object.assign(Error('Intake cannot execute deploys or rollbacks.'),{status:403});
          run=await this.#save({...run,phase:'executing'});
          const deadline=AbortSignal.timeout(run.spec.timeoutMinutes*60_000),combined=AbortSignal.any([signal,deadline]);let outcome;
          try{const onProcess=(native:NativeProcess)=>writeDocument(this.#processPath(run),JobProcessSchema,{...native,schema:'project-job-process-v1',turn:1,startedAt:new Date(this.o.now()).toISOString()});if(run.intakeLanding){const landed=await this.intakeLanding.execute(run,combined,onProcess);await this.#finish(run,landed.conclusion,landed.summary);return;}outcome=await this.intake.check(run,combined,onProcess);}
          catch(error){intakeTimedOut=deadline.aborted&&!signal.aborted;throw error;}
          finally{await this.#stopRecordedProcess(run);}
          run=await this.#save({...run,intake:outcome.result});await this.#finish(run,outcome.conclusion,outcome.summary);return;
        }
        if (run.deployment) {
          const main = await this.mainHead(run.projectId);
          if ((await this.o.git.run(repo, ['merge-base', '--is-ancestor', run.commit, main], { permitted: [1, 128] })).code !== 0) throw new Error(`Commit ${run.commit} is not on origin/main. Deploys build only from main.`);
        }
        const commandSpec = run.spec;
        run = await this.#save({ ...run, phase: 'executing' });
        const workspace = this.o.homes.ensure('project-work', run.projectId, 'job-workspaces', run.id);
        const path = commandSpec.cwd === 'workspace' || run.deployment ? join(workspace, 'checkout') : this.o.homes.at('worktrees', run.projectId, 'jobs', run.id);
        if (commandSpec.cwd === 'workspace') this.o.homes.ensure('project-work', run.projectId, 'job-workspaces');
        this.o.homes.ensure('worktrees', run.projectId, 'jobs');
        if (existsSync(path)) throw new Error('A leftover job worktree needs cleanup before retry.');
        const driverPath = join(workspace, 'driver'); let driverAdded = false; let commandCheckout = path;
        let added = false; let outcome: { conclusion: NonNullable<ProjectJobRun['conclusion']>; summary: string; logTail: string } | undefined;
        try {
          // Fetch the exact gate commit without moving origin/base or the registered checkout.
          if (!await this.o.git.resolve(repo, run.commit)) await this.o.git.run(repo, ['fetch', '--refmap=', '--no-write-fetch-head', '--no-tags', 'origin', run.commit]);
          await this.o.git.run(repo, ['worktree', 'add', '--detach', path, run.commit]); added = true;
          const commandCommit = run.deployment?.commandCommit;
          if (commandCommit && commandCommit !== run.commit) {
            if (!await this.o.git.resolve(repo, commandCommit)) await this.o.git.run(repo, ['fetch', '--refmap=', '--no-write-fetch-head', '--no-tags', 'origin', commandCommit]);
            await this.o.git.run(repo, ['worktree', 'add', '--detach', driverPath, commandCommit]); driverAdded = true; commandCheckout = driverPath;
          }
          const identity = await this.o.git.identity(repo);
          const gitEnv = { ...await this.o.github.turnGitEnvironment(run.projectId, await this.o.git.remoteUrl(repo) ?? ''), ...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}) };
          if (commandSpec.deliveryGate) {
            const merges = [];
            for (const task of await this.o.tasks.list(run.projectId)) {
              if (!task.jobDelivery || !task.threadId) continue;
              const source = (await this.o.hub.jobRun(task.jobDelivery.runId))?.document;
              const delivery = source?.deliveries?.find(row => row.id === task.jobDelivery!.deliveryId);
              const thread = (await this.o.hub.thread(task.threadId))?.document;
              if (delivery?.gate?.id === commandSpec.deliveryGate.id && thread?.landing?.method === 'merge-commit' && thread.landing.checks.some(check => check.name === delivery.gate!.id && check.passed)) merges.push({ taskId: task.id, pr: task.id, runId: source!.id, deliveryId: delivery.id, title: task.title, mergedAt: thread.landing.at, mergeSha: thread.landing.commit, gate: delivery.gate.id, mergeStrategy: 'merge' as const, gatePassed: true as const, date: thread.landing.at.slice(0, 10) });
            }
            writeDocument(join(this.o.homes.ensure('project-work', run.projectId, 'job-cache', run.projectId, 'legal-loop'), 'landing-receipts.json'), LegalLandingReceiptsSchema, { schema: 'jevellan-legal-landings-v1', merges: merges.sort((a, b) => a.date.localeCompare(b.date) || a.taskId.localeCompare(b.taskId)).slice(-1000), reverts: [] });
          }
          const setupCommand = run.setupCommand;
          const onProcess = (native: NativeProcess) => { writeDocument(this.#processPath(run), JobProcessSchema, { ...native, schema: 'project-job-process-v1', turn: 1, startedAt: new Date(this.o.now()).toISOString() }); };
          const setup = setupCommand ? await runThreadCommand(path, setupCommand, { homes: this.o.homes, workId: run.id, timeoutMs: SETUP_TIMEOUT_MS, redactor: this.o.redactor, projectEnv: await this.o.projectEnvironment?.(run.projectId) ?? {}, signal, minimal: true, environmentScope: 'command', gitEnv, jobContext: { schema: 'project-job-context-v1', workspace, commandCheckout, runId: run.id, projectId: run.projectId, jobId: run.jobId, commit: run.commit, ...(run.deployment ? { deployment: run.deployment } : {}) }, onProcess }) : null;
          if (setup && (setup.timedOut || setup.code !== 0)) outcome = { conclusion: setup.timedOut ? 'timed-out' : 'failed', summary: 'The project setup command failed.', logTail: outputTail(setup, 8000) };
          else {
            if (driverAdded && existsSync(join(path, 'node_modules')) && !existsSync(join(driverPath, 'node_modules'))) symlinkSync(join(path, 'node_modules'), join(driverPath, 'node_modules'), 'dir');
            if (run.deployment) run = await this.#save({ ...run, deploymentCommandStartedAt: new Date(this.o.now()).toISOString() });
            const result = await runThreadCommand(path, commandSpec.command, { homes: this.o.homes, workId: run.id, timeoutMs: commandSpec.timeoutMinutes * 60_000, redactor: this.o.redactor, projectEnv: await this.o.projectEnvironment?.(run.projectId) ?? {}, signal, minimal: true, environmentScope: 'command', gitEnv, jobContext: { schema: 'project-job-context-v1', workspace, commandCheckout, runId: run.id, projectId: run.projectId, jobId: run.jobId, commit: run.commit, ...(run.deployment ? { deployment: run.deployment } : {}) }, onProcess });
          outcome = { conclusion: signal.aborted ? 'cancelled' : result.timedOut ? 'timed-out' : result.code === 0 ? 'passed' : 'failed', summary: result.code === 0 ? 'Command passed.' : result.timedOut ? 'Command timed out.' : `Command exited with ${result.code}.`, logTail: outputTail(result, 8000) }; }
          run = await this.#save({ ...run, deliveries: await importJobDeliveries({ homes: this.o.homes, run, workspace, repo, git: this.o.git, gitEnv, library: this.o.library, redactor: this.o.redactor }) });
          const deployFile = join(workspace, 'project-deploy-job-result.json');
          if (run.deployment && existsSync(deployFile)) {
            const result = ProjectDeployJobResultSchema.parse(this.o.redactor.document(readDocument(deployFile, ProjectDeployJobResultSchema)));
            if (result.commit !== run.commit || result.mode !== run.deployment.mode) throw new Error('The deploy result does not match the approved job.');
            run = { ...run, deployResult: result };
          }
          const findingsFile = existsSync(join(workspace, 'project-job-findings.json')) ? join(workspace, 'project-job-findings.json') : join(path, 'project-job-findings.json');
          if (existsSync(findingsFile)) run = { ...run, findings: ProjectJobFindingsSchema.parse(this.o.redactor.document(readDocument(findingsFile, ProjectJobFindingsSchema))).findings };
        } finally {
          await this.#stopRecordedProcess(run);
          if (driverAdded && commandSpec.cwd !== 'workspace') await this.o.git.run(repo, ['worktree', 'remove', '--force', driverPath]);
          if (added && commandSpec.cwd !== 'workspace') await this.o.git.run(repo, ['worktree', 'remove', '--force', path]);
          await this.o.git.run(repo, ['update-ref', '-d', threadBaseRef(run.id)]).catch(() => undefined);
        }
        if (!outcome) throw new Error('The command has no recorded outcome.');
        await this.#finish(commandSpec.cwd === 'workspace' ? { ...run, workspaceRetainedAt: new Date(this.o.now()).toISOString() } : run, outcome.conclusion, outcome.summary, outcome.logTail);
      }
    } catch (error) {
      run = { ...((await this.o.hub.jobRun(run.id))?.document ?? run), ...(run.deployResult ? { deployResult: run.deployResult } : {}), ...(run.deliveries?.length ? { deliveries: run.deliveries } : {}) };
      if (!run.conclusion) await this.#finish(run, signal.aborted ? 'cancelled' : intakeTimedOut ? 'timed-out' : 'failed', error instanceof Error ? error.message : 'Job execution failed.');
    }
  }
  async #recoverDeliveries(run: ProjectJobRun): Promise<ProjectJobRun> {
    const workspace = this.o.homes.at('project-work', run.projectId, 'job-workspaces', run.id);
    if (run.deliveries?.length || !existsSync(join(workspace, 'project-job-deliveries.json'))) return run;
    const project = await this.o.project(run.projectId), repo = resolveProjectPath(project, this.o.deviceId, this.o.deviceName);
    const gitEnv = await this.o.github.turnGitEnvironment(run.projectId, await this.o.git.remoteUrl(repo) ?? '');
    const deliveries = await importJobDeliveries({ homes: this.o.homes, run, workspace, repo, git: this.o.git, gitEnv, library: this.o.library, redactor: this.o.redactor });
    return this.#save({ ...run, deliveries, workspaceRetainedAt: new Date(this.o.now()).toISOString() });
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
      if (run.deviceId !== this.o.deviceId) { if (run.phase === 'reserved' && (await this.o.hub.coordinator(projectId))?.document.deviceId === this.o.deviceId) { const job = (await this.o.hub.job(run.jobId))?.document; if (job) this.#begin(run, job); } continue; }
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
