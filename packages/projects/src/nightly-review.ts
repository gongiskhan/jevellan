import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { rankAccounts, type AccountService } from '@jevellan/accounts';
import { BridgeResultSchema, ProjectReviewBodySchema, ProjectReviewReportSchema, TurnProcessSchema, bridgeTools, readDocument, stableJson, writeDocument,
  type BridgeTool, type Configuration, type CoordinatorEvent, type Homes, type Project, type ProjectHub, type ProjectReviewBody, type ProjectReviewRun, type ProjectWorkTask, type SecretRedactor } from '@jevellan/core';
import type { BridgeScopeTools } from '@jevellan/conversations';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import type { ProjectTasks } from './tasks.js';
import type { ThreadGit } from './git.js';
import type { TurnLauncher } from './launch.js';
import { endTurnProcess } from './recovery.js';
import { TurnExecution } from './turn-execution.js';
import { derivedId } from './decision-items.js';
import { collectDeviceFacts, deviceResourceRefusal, deviceAllowsWork, type DeviceFacts } from '@jevellan/core';
import { writeReviewInput } from './review-input.js';
import type { ProjectMemoryPort } from '@jevellan/memory';
import { readSessionMemory } from './memory-tools.js';
const ProcessSchema = TurnProcessSchema.extend({ schema: z.literal('project-review-process-v1') });
const refuse = (message: string, status = 409) => Object.assign(new Error(message), { status });
export const REVIEW_APPEND = 'You are reviewing every commit that reached main since this project’s last completed review, including direct pushes. This session is read-only: do not change, commit or push anything. Read the complete supplied commit range and repository rules. Report worthwhile findings together, with concrete locations and explanations, or report none. End with exactly one jevellan_project_review_report. The coordinator chooses at most one combined finding task from your report.';
export class ReviewTools implements BridgeScopeTools {
  #active = true; #pending: Promise<unknown> = Promise.resolve(); #report: ProjectReviewBody | null = null;
  readonly abort = new AbortController();
  constructor(readonly save: (body: ProjectReviewBody) => Promise<void>, readonly redactor: SecretRedactor, readonly memory?: ProjectMemoryPort) {}
  get report() { return this.#report; }
  list() { if (!this.#active) throw refuse('This review token has expired.', 401); return bridgeTools(this.memory ? ['jevellan_project_review_report', 'memory_search', 'memory_read'] : ['jevellan_project_review_report']); }
  capture() { return Promise.resolve(BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { queued: false, reason: 'review' } })); }
  call(name: BridgeTool, raw: unknown) {
    const result = this.#pending.then(async () => {
      this.list();
      if (this.memory && (name === 'memory_search' || name === 'memory_read')) return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: this.redactor.document(await readSessionMemory(this.memory, name, raw, this.redactor, this.abort.signal)) });
      if (name !== 'jevellan_project_review_report') throw refuse('The nightly reviewer can read memory and report its review.', 403);
      const body = ProjectReviewBodySchema.parse(this.redactor.document(raw));
      if (this.#report && stableJson(body) !== stableJson(this.#report)) throw refuse('This review already reported a different result.');
      if (!this.#report) { await this.save(body); this.#report = body; }
      return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { schema: 'project-review-receipt-v1', accepted: true } });
    }); this.#pending = result.then(() => undefined, () => undefined); return result;
  }
  async close() { this.#active = false; this.abort.abort(); await this.#pending; }
}
/** Reviews have no coding thread or publishing path. The final checked report and watermark share one task CAS write. */
export class NightlyReview {
  readonly #active = new Map<string, { promise: Promise<void>; execution?: TurnExecution }>(); #closed = false;
  constructor(readonly o: { hub: ProjectHub; tasks: ProjectTasks; homes: Homes; git: ThreadGit; launcher: TurnLauncher; deviceId: string; deviceName?: string; facts?(): DeviceFacts; redactor: SecretRedactor; now(): number;
    settings(): Promise<Configuration['x-jevellan']>; accounts: Pick<AccountService, 'list' | 'recordUsage' | 'recordError'>; runtimes: ReadonlyMap<string, RuntimeAdapter>;
    project(id: string): Promise<Project>; repository(project: Project): string; baseBranch(repo: string): Promise<string>; timeoutMs: number;
    memory?(projectId: string): Promise<ProjectMemoryPort>; event(projectId: string, event: CoordinatorEvent): Promise<void>; changed(): void }) {}
  busy(projectId?: string) { return projectId ? this.#active.has(projectId) : this.#active.size > 0; }
  #path(task: ProjectWorkTask) { return this.o.homes.at('worktrees', task.projectId, 'nightly-reviews', task.id); }
  #process(task: ProjectWorkTask) { return join(this.o.homes.ensure('project-work', task.projectId, 'review-processes'), `${task.id}.json`); }
  async #update(task: ProjectWorkTask, apply: (current: ProjectWorkTask) => ProjectWorkTask) {
    return this.o.tasks.exclusive(task.projectId, async () => this.o.tasks.save(apply(await this.o.tasks.read(task.projectId, task.id))));
  }
  async #notify(task: ProjectWorkTask) {
    if (task.reviewRun?.state === 'completed' && task.reviewRun.report) await this.o.event(task.projectId, { schema: 'coordinator-event-v1', kind: 'project-reviewed', id: derivedId('cev', 'project-reviewed', task.id), at: task.reviewRun.completedAt!, report: task.reviewRun.report });
  }
  async start(task: ProjectWorkTask) {
    if (this.#closed || this.busy(task.projectId)) return;
    if (!deviceAllowsWork(this.o.homes)) throw refuse('This device serves apps only; project work runs on a working device.');
    const reason = deviceResourceRefusal(this.o.deviceName ?? this.o.deviceId, this.o.facts?.() ?? collectDeviceFacts(this.o.homes));
    if (reason) throw Object.assign(refuse(reason), { resourceRefusal: true });
    const project = await this.o.project(task.projectId), repo = this.o.repository(project), base = await this.o.baseBranch(repo), ref = `refs/jevellan/threads/${task.id}/base`;
    const head = await this.o.git.fetchPrivate(repo, base, ref) ?? await this.o.git.resolve(repo, `refs/heads/${base}`);
    if (!head) throw refuse('The project has no published main commit for review.');
    const tasks = await this.o.tasks.list(task.projectId), priorTask = tasks.filter(row => row.reviewRun?.state === 'completed').sort((a, b) => b.reviewRun!.sequence - a.reviewRun!.sequence || b.reviewRun!.completedAt!.localeCompare(a.reviewRun!.completedAt!))[0], prior = priorTask?.reviewRun;
    const daily = task.dailyId ? (await this.o.hub.daily(task.dailyId))?.document : null;
    const baseline = daily?.target.kind === 'review-since-last' ? daily.target.reviewFromCommit : undefined;
    const fromCommit = prior && priorTask?.dailyId === task.dailyId && (daily?.reviewFromVersion ?? 0) === (prior.reviewFromVersion ?? 0) ? prior.commit : baseline ?? prior?.commit ?? head;
    if (fromCommit && (await this.o.git.run(repo, ['merge-base', '--is-ancestor', fromCommit, head], { permitted: [1] })).code !== 0) throw refuse('Main no longer contains the last reviewed commit. The owner must reconcile its history.');
    const [config, accounts] = await Promise.all([this.o.settings(), this.o.accounts.list()]);
    const weights = new Map<string, number>(); let after: string | undefined;
    do { const page = await this.o.hub.mergeDocuments(task.projectId, after); after = page.next ?? undefined;
      for (const row of page.records) if (row.schema === 'merge-route-v1' && row.state === 'merged' && (row.mergedAt ?? row.at) >= (prior?.completedAt ?? '')) {
        const thread = (await this.o.hub.thread(row.threadId))?.document;
        if (thread?.pr?.state === 'merged') weights.set(thread.runtime, (weights.get(thread.runtime) ?? 0) + row.packet.totalSize);
      }
    } while (after);
    const majorityProvider = [...weights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const coordinator = (await this.o.hub.settings(task.projectId))?.document.coordinator;
    const baselineProvider = majorityProvider ?? coordinator?.runtimeId ?? config.menu.find(model => model.id === coordinator?.modelId)?.runtime ?? config.menu.find(model => model.enabled)?.runtime;
    const model = config.menu.find(model => model.runtime !== baselineProvider && model.enabled && model.efforts.includes('high') && config.runtimes[model.runtime]?.enabled && this.o.runtimes.get(model.runtime)?.capabilities.readOnlyEnforced &&
      rankAccounts({ accounts: accounts.map(view => view.account), statuses: accounts.flatMap(view => view.statuses), runtime: model.runtime, model: model.model, deviceId: this.o.deviceId }).some(entry => entry.eligible && entry.account.runtime === model.runtime));
    if (!model) { await this.o.git.run(repo, ['update-ref', '-d', ref]); throw refuse('No other provider with read-only sessions and high effort is eligible for the nightly review.'); }
    const run: ProjectReviewRun = { schema: 'project-review-run-v1', sequence: (prior?.sequence ?? 0) + 1, state: 'reserved', commit: head, fromCommit, deviceId: this.o.deviceId, runtime: model.runtime, modelId: model.id, model: model.model, modelLabel: model.label,
      majorityProvider, selectionBasis: majorityProvider ? 'Other provider from the largest attributed merged change volume since the last review; direct pushes remain in the reviewed range.' : 'No attributed merged changes: use the other provider from the configured coordinator. Direct pushes remain in the reviewed range.',
      reviewFromVersion: daily?.reviewFromVersion ?? 0, startedAt: new Date(this.o.now()).toISOString(), report: null, followupChosen: false, fixTaskId: null };
    task = await this.o.tasks.save({ ...task, state: 'active', dispatchedAt: this.o.tasks.at(), reviewRun: run });
    const active: { promise: Promise<void>; execution?: TurnExecution } = { promise: Promise.resolve() };
    active.promise = Promise.resolve().then(() => this.#execute(task, repo, ref, active)).catch(() => undefined).finally(() => { this.#active.delete(task.projectId); this.o.changed(); });
    this.#active.set(task.projectId, active);
  }
  async #execute(task: ProjectWorkTask, repo: string, ref: string, active: { execution?: TurnExecution }) {
    const path = this.#path(task), processPath = this.#process(task); const run = task.reviewRun!;
    let failure: string | null = null, terminated = true;
    try {
      task = await this.#update(task, current => ({ ...current, reviewRun: { ...current.reviewRun!, state: 'running' } }));
      this.o.homes.ensure('worktrees', task.projectId, 'nightly-reviews');
      if (existsSync(path)) throw new Error('A previous review worktree needs confirmed cleanup.');
      await this.o.git.run(repo, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'worktree', 'add', '--detach', path, run.commit]);
      const range = `${run.fromCommit ?? run.commit}..${run.commit}`;
      const input = join(this.o.homes.ensure('project-work', task.projectId, 'reviews', task.id), 'changes.diff');
      await writeReviewInput(this.o.homes, this.o.redactor, repo, range, input);
      const tools = new ReviewTools(async body => { task = await this.#update(task, current => ({ ...current, reviewRun: { ...current.reviewRun!, report: ProjectReviewReportSchema.parse({ ...body, schema: 'project-review-report-v1', projectId: task.projectId, taskId: task.id,
        fromCommit: run.fromCommit, commit: run.commit, reviewedAt: new Date(this.o.now()).toISOString(), runtime: run.runtime, model: run.model }) } })); }, this.o.redactor, await this.o.memory?.(task.projectId));
      const launched = await this.o.launcher.launch({ owner: { kind: 'review', projectId: task.projectId, id: task.id }, turn: 1, runtime: run.runtime, modelId: run.modelId, model: run.model, modelLabel: run.modelLabel, effort: 'high', permissions: 'read-only', cwd: path, safetyProfile: 'review',
        systemAppend: REVIEW_APPEND, prompt: () => `Review since last\nMain at ${run.commit}; review from commit ${run.fromCommit ?? run.commit}.\nRead every commit and patch in ${input}, then inspect the affected source in this fresh worktree. If that file says patches exceed its cap, read the remaining patches with git in this worktree.\n${run.selectionBasis}`, tools, timeoutMs: this.o.timeoutMs });
      if (launched.kind === 'unavailable') { await tools.close(); throw new Error(launched.reason); }
      terminated = false;
      try {
        if (this.#closed) { await launched.run.terminate(); terminated = true; return; }
        active.execution = new TurnExecution({ run: launched.run, accountId: launched.accountId, secretRef: launched.secretRef, model: run.model, deviceId: this.o.deviceId, accounts: this.o.accounts, initialUsage: launched.usage, onSession: () => {},
          onProcess: native => writeDocument(processPath, ProcessSchema, { schema: 'project-review-process-v1', turn: 1, startedAt: new Date(this.o.now()).toISOString(), ...native }), redactor: this.o.redactor });
        const outcome = await active.execution.done; terminated = true;
        rmSync(processPath, { force: true });
        if (outcome.status !== 'completed' || !tools.report) throw new Error(outcome.error?.message ?? 'The review ended without its required report.');
        if (await this.o.git.resolve(path, 'HEAD') !== run.commit || (await this.o.git.run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout) throw new Error('The read-only review changed its worktree or created a commit.');
        task = await this.#update(task, current => ({ ...current, state: 'done', endedAt: this.o.tasks.at(), reviewRun: { ...current.reviewRun!, state: 'completed', completedAt: this.o.tasks.at() } }));
        await this.#notify(task);
      } finally { await launched.release(); }
    } catch (error) { failure = this.o.redactor.text(error instanceof Error ? error.message : 'The nightly review failed.').slice(0, 400); }
    finally {
      if (terminated) {
        if (existsSync(processPath)) { await endTurnProcess(readDocument(processPath, ProcessSchema)); rmSync(processPath); }
        if (existsSync(path)) await this.o.git.run(repo, ['worktree', 'remove', '--force', path]);
        await this.o.git.run(repo, ['update-ref', '-d', ref]);
      }
    }
    if (failure && terminated) await this.#update(task, current => ({ ...current, state: 'failed', endedAt: this.o.tasks.at(), endNote: failure!, reviewRun: { ...current.reviewRun!, state: 'failed' } }));
  }
  async sweep(projectId: string) {
    if (this.busy(projectId) || this.#closed) return;
    for (const task of await this.o.tasks.list(projectId)) if (task.nightlyReview && task.reviewRun) {
      if (task.reviewRun.state === 'completed') { await this.#notify(task); continue; }
      if (['reserved', 'running'].includes(task.reviewRun.state)) {
        const processPath = this.#process(task); if (existsSync(processPath)) { await endTurnProcess(readDocument(processPath, ProcessSchema)); rmSync(processPath); }
        const project = await this.o.project(projectId), repo = this.o.repository(project), path = this.#path(task);
        if (existsSync(path)) await this.o.git.run(repo, ['worktree', 'remove', '--force', path]);
        await this.o.git.run(repo, ['update-ref', '-d', `refs/jevellan/threads/${task.id}/base`]);
        await this.#update(task, current => ({ ...current, state: 'failed', endedAt: this.o.tasks.at(), endNote: 'The daemon restarted during review; the review was not repeated and its watermark was not advanced.', reviewRun: { ...current.reviewRun!, state: 'failed' } }));
      }
    }
  }
  async close() { this.#closed = true; await Promise.allSettled([...this.#active.values()].map(async active => { await active.execution?.shutdown(); await active.promise; })); }
}
