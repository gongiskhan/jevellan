import { createHash } from 'node:crypto';
import { ProjectGoalSchema, ProjectDecisionSchema, ProjectDeployBaselineSchema, ProjectDeploySchema, ProjectDeployViewSchema, ProjectWorkTaskSchema, stableJson,
  type CoordinatorEvent, type DecisionAnswer, type ProjectDecision, type ProjectDeploy, type ProjectDeployBaseline, type ProjectHealthCheck, type ProjectHealthRun, type ProjectJobRun, type ProjectHub, type ProjectWorkSettings, type SecretRedactor, type ThreadIndex } from '@jevellan/core';
import type { ProjectJobRunner } from './job-runner.js';
import type { ProjectTasks } from './tasks.js';
import { derivedId } from './decision-items.js';
import { taskRankBetween } from './tasks.js';
const short = (sha: string | null) => sha?.slice(0, 7) ?? 'unknown';
const time = (at: string, timezone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const refuse = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
type Options = { hub: ProjectHub; tasks: ProjectTasks; jobs: ProjectJobRunner; deviceId: string; redactor: SecretRedactor; now(): number;
  discoverBaseline?(id: string): Promise<string | null>;
  settings(id: string): Promise<ProjectWorkSettings>;
  health(id: string, checks: ProjectHealthCheck[], trigger: ProjectHealthRun['trigger'], deployId: string): Promise<ProjectHealthRun[]>;
  diff(id: string, before: string, after: string): Promise<string[]>;
  onMain(id: string, commit: string): Promise<void>;
  environment(id: string): Promise<Record<string, string>>;
  resolution(id: string, thread: ProjectDeploy['threads'][number], deployId: string, clear: boolean): Promise<void>;
  event(id: string, event: CoordinatorEvent): Promise<void>; changed(): void };
/** The assigned coordinator advances this durable state machine. Jobs execute only immutable owner-approved pins. */
export class ProjectDeployService {
  readonly #chains = new Map<string, Promise<unknown>>();
  constructor(readonly o: Options) {}
  #exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(id) ?? Promise.resolve()).then(action), tail = result.then(() => undefined, () => undefined);
    this.#chains.set(id, tail); void tail.then(() => { if (this.#chains.get(id) === tail) this.#chains.delete(id); }); return result;
  }
  #at() { return new Date(this.o.now()).toISOString(); }
  async #writer(id: string) { if ((await this.o.hub.coordinator(id))?.document.deviceId !== this.o.deviceId) refuse('Deploys are controlled on the coordinator device.'); }
  async records(id: string): Promise<ProjectDeploy[]> {
    const rows: ProjectDeploy[] = []; let after: string | undefined;
    do { const page = await this.o.hub.deploys(id, after); rows.push(...page.records); after = page.next ?? undefined; } while (after);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async view(id: string) { return ProjectDeployViewSchema.parse({ schema: 'project-deploy-view-v1', projectId: id, records: await this.records(id), baseline: (await this.o.hub.deployBaseline(id))?.document ?? null }); }
  async baseline(id: string, raw: Omit<ProjectDeployBaseline, 'schema' | 'id' | 'projectId' | 'revision' | 'updatedAt'>, revision: number) {
    await this.#writer(id); return (await this.o.hub.putDeployBaseline(ProjectDeployBaselineSchema.parse({ ...raw, schema: 'project-deploy-baseline-v1', id, projectId: id, revision, updatedAt: this.#at() }), revision)).document;
  }
  async #save(row: ProjectDeploy): Promise<ProjectDeploy> { return (await this.o.hub.putDeploy(ProjectDeploySchema.parse(this.o.redactor.document({ ...row, updatedAt: this.#at() })), row.revision)).document; }
  #current(rows: ProjectDeploy[], baseline: ProjectDeployBaseline | null): { commit: string | null; rollbackAvailable: boolean } {
    const events = rows.flatMap(row => [
      ...(row.deployedAt ? [{ at: row.deployedAt, commit: row.releaseUncertain ? null : row.commit, rollbackAvailable: !row.releaseUncertain }] : []),
      ...(row.rollback ? [{ at: row.rollback.at, commit: row.rollback.result === 'done' ? row.rollback.toCommit : null, rollbackAvailable: row.rollback.result === 'done' }] : []),
    ]).sort((a, b) => b.at.localeCompare(a.at));
    if (baseline && (!events[0] || Date.parse(baseline.updatedAt) > Date.parse(events[0].at))) return { commit: baseline.commit, rollbackAvailable: baseline.rollbackAvailable };
    return events[0] ?? { commit: baseline?.commit ?? null, rollbackAvailable: baseline?.rollbackAvailable ?? false };
  }
  async #threads(id: string): Promise<ThreadIndex[]> { const rows: ThreadIndex[] = []; let after: string | undefined; do { const page = await this.o.hub.threads(id, after); rows.push(...page.records); after = page.next ?? undefined; } while (after); return rows; }
  #question(row: ProjectDeploy): string {
    const lines = [`Deploy ${row.threads.length} landed thread(s) to production at ${short(row.commit)}?`, ...row.threads.map(thread => `- ${thread.title} (${short(thread.landingCommit)})`), `Full suite on ${short(row.commit)}: ${row.suite.conclusion ?? 'not run yet'}.`];
    for (const check of row.checks) {
      const run = row.messageHealth.find(run => run.checkId === check.id), failed = run?.steps.find(step => !step.passed);
      lines.push(`${check.name}: ${run ? `${run.passed ? 'passed' : 'failed'} at ${time(run.at, row.timezone)}${failed ? `: ${failed.name}: ${failed.reason ?? 'failed'}` : ''}` : 'not run yet'}`);
    }
    if (!row.rollbackAvailable) lines.push(`Rollback not available: no image for ${short(row.previousCommit)}.`);
    if (row.desktopPlan?.state === 'skipped') lines.push(`Desktop build skipped: ${row.desktopPlan.reason ?? 'not available'}`);
    if (row.desktopPlan?.state === 'waiting') lines.push('Desktop build will run after the health checks pass.');
    if (row.notNowAt) lines.push(`Not now at ${time(row.notNowAt, row.timezone)}`);
    if (row.rollbackNotice) lines.push(row.rollbackNotice);
    return lines.join('\n');
  }
  async #message(row: ProjectDeploy) {
    const previous = (await this.o.hub.decision(row.decisionId))?.document;
    const document = ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: previous?.revision ?? 0, id: row.decisionId, projectId: row.projectId, from: 'coordinator', createdAt: previous?.createdAt ?? row.createdAt,
      ...(row.state !== 'open' && previous?.answer ? { answer: previous.answer, answeredAt: previous.answeredAt } : {}), question: this.#question(row), options: [{ label: `Deploy ${short(row.commit)}` }, { label: 'Not now' }], deploy: { deployId: row.id, action: 'approve' } });
    if (!previous) await this.o.hub.createDecision(document); else if (stableJson({ ...previous, revision: 0 }) !== stableJson({ ...document, revision: 0 })) await this.o.hub.updateDeployDecision(document, previous.revision);
  }
  async #open(id: string, rows: ProjectDeploy[], settings: ProjectWorkSettings) {
    let row = rows.findLast(row => row.state === 'open');
    const held = new Set(rows.filter(item => ['approved', 'running', 'deployed'].includes(item.state)).flatMap(item => item.threads.map(thread => `${thread.threadId}:${thread.landingCommit}`)));
    const landings = new Map([...rows.filter(item => item.state === 'failed').flatMap(item => item.threads), ...(row?.threads ?? [])].map(thread => [thread.threadId, thread]));
    const routes = []; let after: string | undefined;
    do { const page = await this.o.hub.mergeDocuments(id, after); routes.push(...page.records); after = page.next ?? undefined; } while (after);
    for (const route of routes.filter(item => item.schema === 'landing-route-v1').sort((a, b) => a.at.localeCompare(b.at))) if (route.state === 'landed' && route.candidate) landings.set(route.threadId, { threadId: route.threadId, title: route.packet.title, landingCommit: route.candidate.commit });
    for (const thread of await this.#threads(id)) if (thread.landing) landings.set(thread.id, { threadId: thread.id, title: thread.title, landingCommit: thread.landing.commit });
    const threads = [...landings.values()].filter(thread => !held.has(`${thread.threadId}:${thread.landingCommit}`));
    if (!threads.length) return;
    if (!row && threads.every(thread => rows.some(item => item.state === 'failed' && item.threads.some(prior => prior.threadId === thread.threadId && prior.landingCommit === thread.landingCommit)))) return;
    let baseline = (await this.o.hub.deployBaseline(id))?.document ?? null;
    if (!baseline && this.o.discoverBaseline) { const commit = await this.o.discoverBaseline(id); baseline = await this.baseline(id, { commit, rollbackAvailable: false, migrationPaths: [], desktopPaths: [], desktopSecretNames: [], desktopSecretAlternatives: [] }, 0); }
    const current = this.#current(rows, baseline), commit = row && stableJson(row.threads) === stableJson(threads) ? row.commit : await this.o.jobs.mainHead(id);
    const checks = settings.healthChecks.filter(check => check.enabled), runs = await this.o.jobs.runs(id), suiteRun = runs.find(run => run.jobId === settings.deploy.suiteJobId && run.commit === commit);
    const suite = { commit, conclusion: suiteRun?.conclusion === 'passed' ? 'passed' as const : suiteRun?.conclusion && suiteRun.conclusion !== 'skipped' ? 'failed' as const : null, ...(suiteRun ? { runId: suiteRun.id } : {}) };
    const at = this.#at(), deployId = row?.id ?? derivedId('deploy', id, commit, at);
    const draft = ProjectDeploySchema.parse({ ...(row ?? { schema: 'project-deploy-v1', id: deployId, projectId: id, revision: 0, state: 'open', health: { before: [], after: [] }, decisionId: derivedId('pdec', deployId), createdAt: at }), commit, threads, suite, checks, timezone: settings.nightlyWindow.timezone, previousCommit: current.commit, rollbackAvailable: current.rollbackAvailable, updatedAt: at });
    draft.desktopPlan = await this.#desktopPlan(draft, settings, baseline);
    const fingerprint = (item: ProjectDeploy) => stableJson({ commit: item.commit, threads: item.threads, suite: item.suite, checks: item.checks, timezone: item.timezone, previousCommit: item.previousCommit, rollbackAvailable: item.rollbackAvailable, desktopPlan: item.desktopPlan });
    if (row && fingerprint(row) === fingerprint(draft)) { await this.#message(row); return; }
    row = await this.#save({ ...draft, messageHealth: await this.o.health(id, checks, 'manual', deployId) }); await this.#message(row);
  }
  async #available(row: ProjectDeploy, allowOwnMonitor = false) {
    if (!allowOwnMonitor && row.monitor || row.rollbackPending && !row.rollback || (await this.records(row.projectId)).some(item => item.id !== row.id && (['approved', 'running'].includes(item.state) || item.monitor || item.rollbackPending && !item.rollback))) refuse('A deploy is already running. Wait for it to finish before approving this message.');
  }
  async answer(decision: ProjectDecision, answer: DecisionAnswer, request: { clientRequestId: string; expectedRevision?: number | undefined }): Promise<{ repeated: boolean; closed: boolean }> {
    return this.#exclusive(decision.projectId, async () => {
      await this.#writer(decision.projectId);
      let row = (await this.o.hub.deploy(decision.deploy!.deployId))?.document; if (!row || row.projectId !== decision.projectId) return refuse('Deploy not found.', 404);
      const digest = createHash('sha256').update(stableJson({ decisionId: decision.id, answer })).digest('hex'), old = row.answers.find(item => item.id === request.clientRequestId);
      if (old) { if (old.digest !== digest) refuse('This request ID already answered differently.'); if (old.closed) await this.o.hub.answerDecision(decision.id, answer, this.#at(), request.clientRequestId); else await this.#message(row); return { repeated: true, closed: old.closed }; }
      const latest = (await this.o.hub.decision(decision.id))?.document;
      if (!latest || latest.revision !== request.expectedRevision) refuse('The deploy message changed. Read it again before choosing.');
      if (latest?.answer || latest?.withdrawnAt) refuse('This deploy message is no longer waiting for an answer.');
      let closed = true;
      if (decision.deploy!.action === 'rollback') {
        if (answer.optionLabel?.startsWith('Roll back to ')) row = await this.#queueRollback(row, 'health', row.failure ?? 'health check');
        else if (answer.optionLabel !== 'Leave it') return refuse('Choose a rollback option.', 400); else row = { ...row, state: 'failed' };
      } else if (decision.deploy!.action === 'retry') {
        if (row.state !== 'failed' || row.failureDecisionId !== decision.id) return refuse('This failed deploy is no longer waiting for a retry.');
        if (answer.optionLabel === 'Try again') {
          await this.#available(row); const baseline = (await this.o.hub.deployBaseline(row.projectId))?.document ?? null;
          const current = this.#current(await this.records(row.projectId), baseline); if (!current.commit) return refuse('The current production commit is unknown. Complete the deploy preflight first.');
          const paths = current.commit === row.commit ? [] : await this.o.diff(row.projectId, current.commit, row.commit);
          row = { ...row, state: 'approved', previousCommit: current.commit, rollbackAvailable: current.rollbackAvailable, migrationChanged: paths.some(path => baseline?.migrationPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))), releaseUncertain: false, approvedAt: this.#at(), jobTaskId: derivedId('task', row.id, request.clientRequestId) };
          delete row.jobRunId; delete row.failure; delete row.deployedAt; delete row.monitor; delete row.desktop; delete row.desktopTaskId; delete row.desktopJobRunId;
        }
        else if (answer.optionLabel !== 'Leave it') return refuse('Choose a deploy failure option.', 400);
      } else {
        if (row.state !== 'open') refuse('This deploy has already been approved.');
        if (answer.optionLabel === 'Not now') { closed = false; row = { ...row, notNowAt: this.#at() }; }
        else if (answer.optionLabel === `Deploy ${short(row.commit)}`) {
          await this.#available(row);
          if (!(await this.o.settings(row.projectId)).deploy.jobId) refuse('Choose a deploy job in Settings first.');
          await this.o.onMain(row.projectId, row.commit);
          const current = this.#current(await this.records(row.projectId), (await this.o.hub.deployBaseline(row.projectId))?.document ?? null);
          if (!current.commit) refuse('The current production commit is unknown. Complete the deploy preflight first.');
          const baseline = (await this.o.hub.deployBaseline(row.projectId))?.document;
          const paths = await this.o.diff(row.projectId, current.commit!, row.commit);
          row = { ...row, state: 'approved', previousCommit: current.commit, rollbackAvailable: current.rollbackAvailable, migrationChanged: paths.some(path => baseline?.migrationPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))), approvedAt: this.#at(), jobTaskId: derivedId('task', row.id, request.clientRequestId) };
        } else return refuse('Choose the current pinned deploy option.', 400);
      }
      row = await this.#save({ ...row, answers: [...row.answers, { id: request.clientRequestId, decisionId: decision.id, optionLabel: answer.optionLabel, text: answer.text, digest, closed }] });
      if (closed) await this.o.hub.answerDecision(decision.id, answer, this.#at(), request.clientRequestId); else await this.#message(row);
      this.o.changed(); return { repeated: false, closed };
    });
  }
  async #job(row: ProjectDeploy, taskId: string, mode: 'deploy' | 'rollback' | 'desktop', commit: string): Promise<void> {
    await this.o.tasks.exclusive(row.projectId, async () => {
      if ((await this.o.hub.task(taskId))?.document) return;
      const settings = await this.o.settings(row.projectId), jobId = mode === 'desktop' ? settings.deploy.desktopJobId : settings.deploy.jobId;
      if (!jobId) return refuse('No deploy job is configured.');
      const job = (await this.o.hub.job(jobId))?.document; if (!job?.enabled || job.run.kind !== 'command') return refuse('The deploy command job is unavailable.');
      const tasks = await this.o.tasks.list(row.projectId), at = this.#at();
      await this.o.tasks.save(ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id: taskId, projectId: row.projectId, revision: 0, title: `${mode === 'rollback' ? 'Roll back to' : mode === 'desktop' ? 'Build desktop at' : 'Deploy'} ${short(commit)}`, brief: 'Run the owner-approved pinned command job.', kind: 'job', type: 'feature', goalId: null, source: 'owner', state: 'queued', rank: taskRankBetween(tasks.map(task => task.rank).sort().at(-1) ?? null, null), ownerRanked: false, now: mode !== 'desktop', after: [], needs: [], dailyId: null, jobId, threadId: null, jobRunId: null, fixed: {}, deployment: { deployId: row.id, commandCommit: row.commit, mode, commit, previousCommit: mode === 'rollback' ? row.commit : row.previousCommit }, createdAt: at, updatedAt: at }));
    });
  }
  async #failure(row: ProjectDeploy, summary: string): Promise<ProjectDeploy> {
    row = await this.#save({ ...row, state: 'failed', failure: summary.slice(0, 1200), failureDecisionId: derivedId('pdec', row.id, row.jobTaskId ?? '', 'failed') });
    if (!(await this.o.hub.decision(row.failureDecisionId!))) await this.o.hub.createDecision(ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: 0, id: row.failureDecisionId, projectId: row.projectId, from: 'coordinator', ...(row.deployedAt ? { urgent: true } : {}), question: `The deploy of ${short(row.commit)} failed: ${summary}`.slice(0, 16000), options: [{ label: 'Try again' }, { label: 'Leave it' }], deploy: { deployId: row.id, action: 'retry' }, createdAt: this.#at() }));
    await this.#event(row, 'failed', summary); return this.#save({ ...row, notified: [...new Set([...row.notified, `failure-delivered:${row.failureDecisionId}`])] });
  }
  async #event(row: ProjectDeploy, outcome: 'deployed' | 'failed' | 'rolled-back', summary: string) {
    await this.o.event(row.projectId, { schema: 'coordinator-event-v1', kind: 'deploy', id: derivedId('cev', row.id, outcome, row.rollback?.jobRunId ?? row.jobRunId ?? ''), at: this.#at(), deployId: row.id, commit: row.commit, threads: row.threads.length, outcome, summary: summary.slice(0, 1200) });
  }
  async #notify(row: ProjectDeploy, body: string, key: string) {
    let text = '', bytes = 0; for (const char of Array.from(this.o.redactor.text(body)).slice(0, 2000)) { const size = Buffer.byteLength(char); if (bytes + size > 3000) break; text += char; bytes += size; }
    await this.o.hub.putNotification?.({ schema: 'project-notification-v1', revision: 0, id: derivedId('pnotify', row.id, key), projectId: row.projectId, kind: 'deploy', urgent: true, title: `Deploy ${short(row.commit)}`, body: text, url: `/projects/${row.projectId}`, tag: `${row.projectId}:deploy:${row.id}`, createdAt: row.rollback?.at ?? row.updatedAt });
  }
  async #queueRollback(row: ProjectDeploy, reason: 'health' | 'owner', checkName: string): Promise<ProjectDeploy> {
    if (!row.previousCommit || !row.rollbackAvailable) return refuse('A rollback image is not available.');
    if (row.rollbackPending) return row;
    const taskId = derivedId('task', row.id, 'rollback');
    row = await this.#save({ ...row, monitor: undefined, rollbackPending: { reason, checkName: checkName.slice(0, 80), taskId, jobRunId: derivedId('jrun', taskId), at: this.#at() } });
    await this.#cancelDesktop(row); await this.#job(row, taskId, 'rollback', row.previousCommit!); return row;
  }
  async rollback(id: string, deployId: string, expectedRevision: number) {
    return this.#exclusive(id, async () => {
      await this.#writer(id); const rows = await this.records(id), row = rows.find(row => row.id === deployId);
      if (row?.rollbackPending?.reason === 'owner') return row;
      if (!row || row.revision !== expectedRevision || !row.deployedAt || row.rollback || this.#current(rows, (await this.o.hub.deployBaseline(id))?.document ?? null).commit !== row.commit) return refuse('Only the current latest deploy can be rolled back.');
      await this.#available(row, true);
      return this.#queueRollback(row, 'owner', 'owner request');
    });
  }
  async #broken(row: ProjectDeploy, checkName: string): Promise<ProjectDeploy> {
    if (row.rollbackPending) return row;
    if (!row.rollbackAvailable || !row.previousCommit) { return this.#failure({ ...row, monitor: undefined }, `${checkName} failed after release. Rollback not available.`); }
    if (!row.migrationChanged) return this.#queueRollback(row, 'health', checkName);
    const id = derivedId('pdec', row.id, 'database-rollback');
    if (!row.rollbackDecisionId) row = await this.#save({ ...row, monitor: undefined, failure: checkName, rollbackDecisionId: id });
    if (!(await this.o.hub.decision(id))) await this.o.hub.createDecision(ProjectDecisionSchema.parse({ schema: 'project-decision-v1', id, projectId: row.projectId, revision: 0, from: 'coordinator', urgent: true, deploy: { deployId: row.id, action: 'rollback' }, question: `Deploy ${short(row.commit)} broke ${checkName}. It changed the database, so rolling back may not be safe. Roll back to ${short(row.previousCommit)}?`, options: [{ label: `Roll back to ${short(row.previousCommit)}` }, { label: 'Leave it' }], createdAt: this.#at() }));
    await this.#notify(row, `Deploy ${short(row.commit)} broke ${checkName}. It changed the database, so rolling back may not be safe.`, 'database'); return row;
  }
  async #afterRollback(row: ProjectDeploy, passed: boolean, summary: string): Promise<ProjectDeploy> {
    const pending = row.rollbackPending!;
    const rollback = row.rollback ?? { at: this.#at(), reason: pending.reason, toCommit: row.previousCommit!, jobRunId: pending.jobRunId, result: passed ? 'done' as const : 'failed' as const, ...(!passed ? { failure: summary.slice(0, 1200) } : {}) };
    row = await this.#save({ ...row, state: 'rolled-back', rollback });
    for (const thread of row.threads) await this.o.resolution(row.projectId, thread, row.id, true);
    const body = passed && pending.reason === 'owner' ? `Deploy ${short(row.commit)} was rolled back to ${short(row.previousCommit)} at ${time(rollback.at, row.timezone)} at your request.` : passed ? `Deploy ${short(row.commit)} broke ${pending.checkName} and was rolled back to ${short(row.previousCommit)} at ${time(rollback.at, row.timezone)}.` : `Deploy ${short(row.commit)} broke ${pending.checkName}, and rolling back to ${short(row.previousCommit)} failed: ${summary}.`;
    await this.#notify(row, body, 'rollback'); await this.#event(row, 'rolled-back', `${pending.checkName} failed`);
    const goals = []; let after: string | undefined; do { const page = await this.o.hub.goals(row.projectId, after); goals.push(...page.records); after = page.next ?? undefined; } while (after);
    let goal = goals.find(goal => goal.name === 'Resilience');
    if (!goal) { const at = this.#at(), id = derivedId('goal', row.projectId, 'deploy-resilience'); goal = (await this.o.hub.putGoal(ProjectGoalSchema.parse({ schema: 'project-goal-v1', id, projectId: row.projectId, revision: 0, name: 'Resilience', motivation: 'Prevent deployment regressions and restore project health.', health: '', state: 'active', autonomy: 'propose', dailyRefillCap: 3, openPrCap: 2, createdAt: at, updatedAt: at }), 0)).document; }
    await this.o.tasks.create(row.projectId, { schema: 'task-create-request-v1', clientRequestId: derivedId('deploy_fix', row.id), title: `Fix deploy ${short(row.commit)}`, brief: body, type: 'fix', goalId: goal.id, now: false, after: [], needs: [], fixed: {} }, 'finding');
    const records = await this.records(row.projectId);
    let reopened = records.find(item => item.supersedes === row.id) ?? records.findLast(item => item.state === 'open');
    if (reopened && reopened.supersedes !== row.id) reopened = await this.#save({ ...reopened, previousCommit: passed ? row.previousCommit : null, rollbackAvailable: passed, rollbackNotice: passed ? `Rolled back at ${time(rollback.at, row.timezone)}: ${pending.reason === 'owner' ? 'owner request.' : `${pending.checkName} failed.`}` : `Rollback failed at ${time(rollback.at, row.timezone)}: ${summary}` });
    if (!reopened) { const at = this.#at(); reopened = await this.#save(ProjectDeploySchema.parse({ ...row, id: derivedId('deploy', row.id, 'reopened'), revision: 0, state: 'open', supersedes: row.id, rollbackNotice: passed ? `Rolled back at ${time(rollback.at, row.timezone)}: ${pending.reason === 'owner' ? 'owner request.' : `${pending.checkName} failed.`}` : `Rollback failed at ${time(rollback.at, row.timezone)}: ${summary}`, previousCommit: passed ? row.previousCommit : null, rollbackAvailable: passed, approvedAt: undefined, jobTaskId: undefined, jobRunId: undefined, deployedAt: undefined, rollback: undefined, rollbackPending: undefined, monitor: undefined, rollbackDecisionId: undefined, failureDecisionId: undefined, answers: [], createdAt: at, updatedAt: at })); }
    await this.#message(reopened); return this.#save({ ...row, notified: [...row.notified, 'rollback-delivered'] });
  }
  async #monitor(row: ProjectDeploy): Promise<ProjectDeploy> {
    const monitor = row.monitor; if (!monitor || this.o.now() < Date.parse(monitor.dueAt)) return row;
    const rollback = monitor.stage.startsWith('rollback'), repeat = monitor.stage.includes('repeat'), five = monitor.stage.endsWith('five');
    const checks = repeat ? row.checks.filter(check => monitor.repeatIds.includes(check.id)) : row.checks;
    const runs = await this.o.health(row.projectId, checks, 'deploy-after', row.id);
    if (!repeat && runs.some(run => !run.passed)) return this.#save({ ...row, monitor: { stage: `${rollback ? 'rollback-' : ''}repeat-${five ? 'five' : 'one'}` as NonNullable<ProjectDeploy['monitor']>['stage'], dueAt: new Date(this.o.now() + 30_000).toISOString(), repeatIds: runs.filter(run => !run.passed).map(run => run.checkId) }, health: { ...row.health, after: [...row.health.after, ...runs.filter(run => run.passed).map(run => ({ checkId: run.checkId, passed: true }))].slice(-100) } });
    row = await this.#save({ ...row, messageHealth: [...row.messageHealth.filter(old => !runs.some(run => run.checkId === old.checkId)), ...runs], health: { ...row.health, after: [...row.health.after, ...runs.map(run => ({ checkId: run.checkId, passed: run.passed }))].slice(-100) } });
    await this.#message(row);
    const broken = runs.find(run => !run.passed && row.health.before.some(before => before.checkId === run.checkId && before.passed));
    if (rollback && runs.some(run => !run.passed)) { delete row.monitor; return this.#afterRollback(row, false, 'Health checks still fail after rollback.'); }
    if (broken && !rollback) { return this.#broken(row, row.checks.find(check => check.id === broken.checkId)?.name ?? broken.checkId); }
    if (!five) return this.#save({ ...row, monitor: { stage: rollback ? 'rollback-five' : 'five', dueAt: new Date(Date.parse(rollback ? row.rollbackPending!.at : row.deployedAt!) + 300_000).toISOString(), repeatIds: [] } });
    delete row.monitor;
    if (rollback) return this.#afterRollback(row, true, 'Rollback passed.');
    if (row.failure) return this.#save(row);
    const latestResults = row.checks.map(check => row.health.after.findLast(run => run.checkId === check.id));
    if (latestResults.some(run => !run?.passed)) return this.#failure(row, 'A health check that was already failing before release still fails. No automatic rollback was made.');
    row = await this.#save({ ...row, state: 'deployed' });
    return this.#concluded(row);
  }
  async #concluded(row: ProjectDeploy): Promise<ProjectDeploy> {
    for (const thread of row.threads) await this.o.resolution(row.projectId, thread, row.id, false);
    await this.#event(row, 'deployed', 'Health checks completed.'); return this.#save({ ...row, notified: [...row.notified, 'deploy-delivered'] });
  }
  async #advance(row: ProjectDeploy) {
    if (row.rollbackPending && !row.rollback) {
      await this.#cancelDesktop(row);
      await this.#job(row, row.rollbackPending.taskId, 'rollback', row.previousCommit!);
      const run = (await this.o.hub.jobRun(row.rollbackPending.jobRunId))?.document;
      if (!run?.conclusion) return;
      if (run.conclusion !== 'passed' || !run.deployResult?.released) return this.#afterRollback(row, false, run.summary);
      if (!row.monitor?.stage.startsWith('rollback')) row = await this.#save({ ...row, rollbackPending: { ...row.rollbackPending, at: run.endedAt! }, monitor: { stage: 'rollback-one', dueAt: new Date(Date.parse(run.endedAt!) + 60_000).toISOString(), repeatIds: [] } });
      return this.#monitor(row);
    }
    if (row.state === 'approved') {
      row = await this.#save({ ...row, state: 'running', health: { before: [], after: [] }, jobRunId: derivedId('jrun', row.jobTaskId!) });
      await this.#job(row, row.jobTaskId!, 'deploy', row.commit);
    }
    if (row.state === 'running' && !row.deployedAt) {
      await this.#job(row, row.jobTaskId!, 'deploy', row.commit);
      const run = row.jobRunId ? (await this.o.hub.jobRun(row.jobRunId))?.document : null;
      if (!run?.conclusion) return;
      const unknown = !!run.deploymentCommandStartedAt && !run.deployResult;
      if (run.conclusion !== 'passed' && !run.deployResult?.released && !run.deployResult?.releaseStarted && !unknown) return this.#failure(row, run.summary);
      if (!run.deployResult?.released && !run.deployResult?.releaseStarted && !unknown) return this.#failure(row, 'The job did not confirm that the pinned commit was released.');
      row = await this.#save({ ...row, deployedAt: run.endedAt!, releaseUncertain: !run.deployResult?.released, rollbackAvailable: !!run.deployResult && run.deployResult.previousCommit === row.previousCommit && run.deployResult.rollbackAvailable, migrationChanged: row.migrationChanged || !!run.deployResult?.migrationChanged, ...(run.conclusion !== 'passed' ? { failure: run.summary } : {}), monitor: { stage: 'one', dueAt: new Date(Date.parse(run.endedAt!) + 60_000).toISOString(), repeatIds: [] } });
      if (run.conclusion !== 'passed' || unknown) row = await this.#failure(row, unknown ? 'The deploy command ended without a valid result. Production may have changed.' : run.summary);
    }
    await this.#monitor(row);
  }
  async beforeJob(run: ProjectJobRun): Promise<void> { return this.#exclusive(run.projectId, async () => {
    await this.#writer(run.projectId); let row = (await this.o.hub.deploy(run.deployment!.deployId))?.document;
    if (!row || row.state !== 'running' || row.jobRunId !== run.id || row.commit !== run.commit) return refuse('This job no longer matches its approved deploy.');
    if (row.healthBeforeJobRunId === run.id) return;
    const before = await this.o.health(row.projectId, row.checks, 'deploy-before', row.id);
    row = await this.#save({ ...row, healthBeforeJobRunId: run.id, messageHealth: before, health: { before: before.map(run => ({ checkId: run.checkId, passed: run.passed })), after: [] } }); await this.#message(row);
  }); }
  async #desktopPlan(row: ProjectDeploy, settings: ProjectWorkSettings, baseline: ProjectDeployBaseline | null): Promise<NonNullable<ProjectDeploy['desktopPlan']>> {
    if (!settings.deploy.desktopJobId) return { state: 'not-needed' };
    if (!row.previousCommit || !baseline?.desktopPaths.length) return { state: 'skipped', reason: 'Previous deployment or desktop paths are not configured.' };
    const paths = await this.o.diff(row.projectId, row.previousCommit, row.commit);
    if (!paths.some(path => baseline.desktopPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)))) return { state: 'not-needed' };
    const env = await this.o.environment(row.projectId), missing = baseline.desktopSecretNames.filter(name => !env[name]);
    if (baseline.desktopSecretAlternatives.length && !baseline.desktopSecretAlternatives.some(group => group.every(name => !!env[name]))) missing.push(...new Set(baseline.desktopSecretAlternatives.flat().filter(name => !env[name])));
    return missing.length ? { state: 'skipped', reason: `Missing signing secrets: ${missing.join(', ')}`.slice(0, 1000) } : { state: 'waiting' };
  }
  async #desktop(row: ProjectDeploy): Promise<ProjectDeploy> {
    const plan = await this.#desktopPlan(row, await this.o.settings(row.projectId), (await this.o.hub.deployBaseline(row.projectId))?.document ?? null);
    if (plan.state !== 'waiting') return this.#save({ ...row, desktop: plan });
    const taskId = derivedId('task', row.id, 'desktop'); row = await this.#save({ ...row, desktop: plan, desktopTaskId: taskId, desktopJobRunId: derivedId('jrun', taskId) }); await this.#job(row, taskId, 'desktop', row.commit); return row;
  }
  async #cancelDesktop(row: ProjectDeploy): Promise<void> {
    if (row.desktopJobRunId) { const run = (await this.o.hub.jobRun(row.desktopJobRunId))?.document; if (run && !run.conclusion && run.phase !== 'waiting') await this.o.jobs.cancel(row.projectId); }
    if (row.desktopTaskId) await this.o.tasks.exclusive(row.projectId, async () => { const task = (await this.o.hub.task(row.desktopTaskId!))?.document; if (task?.state === 'queued') await this.o.tasks.save({ ...task, state: 'cancelled', endedAt: this.#at(), endNote: 'Desktop build skipped because production is rolling back.' }); });
  }
  async sweep(id: string) { return this.#exclusive(id, async () => {
    await this.#writer(id); const settings = await this.o.settings(id); if (settings.status !== 'active') return;
    for (let row of await this.records(id)) {
      for (const receipt of row.answers.filter(receipt => receipt.closed)) { const decision = (await this.o.hub.decision(receipt.decisionId))?.document; if (decision && !decision.answer && decision.deploy?.deployId === row.id) await this.o.hub.answerDecision(decision.id, { optionLabel: receipt.optionLabel, text: receipt.text, source: 'panel' }, row.approvedAt ?? row.updatedAt, receipt.id); }
      if (row.state === 'failed' && row.failureDecisionId && !row.notified.includes(`failure-delivered:${row.failureDecisionId}`)) row = await this.#failure(row, row.failure ?? 'The deploy job failed.');
      if (row.rollbackDecisionId && !(await this.o.hub.decision(row.rollbackDecisionId))) row = await this.#broken(row, row.failure ?? 'health check');
      if (row.state === 'deployed' && !row.notified.includes('deploy-delivered')) row = await this.#concluded(row);
      if (row.rollback && !row.notified.includes('rollback-delivered')) row = await this.#afterRollback(row, row.rollback.result === 'done', row.rollback.failure ?? 'Rollback passed.');
      if (['approved', 'running'].includes(row.state) || row.monitor || row.rollbackPending && !row.rollback) await this.#advance(row);
      row = (await this.o.hub.deploy(row.id))!.document;
      if (row.state === 'deployed' && !row.desktop) row = await this.#desktop(row);
      if (row.desktop?.state === 'waiting' && row.desktopJobRunId) { const run = (await this.o.hub.jobRun(row.desktopJobRunId))?.document; if (run?.conclusion) { row = (await this.o.hub.deploy(row.id))!.document; await this.#save({ ...row, desktop: run.deployResult?.desktop ?? { state: run.conclusion === 'passed' ? 'built' : 'failed', reason: run.summary } }); } }
    }
    await this.#open(id, await this.records(id), settings);
  }); }
}
