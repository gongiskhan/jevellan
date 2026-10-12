import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { collectDeviceFacts, deviceResourceRefusal, deviceAllowsWork, type DeviceFacts } from '@jevellan/core';
import { rankAccounts, type AccountService } from '@jevellan/accounts';
import { BridgeResultSchema, TurnProcessSchema, VerificationReportSchema, VerificationRunSchema, bridgeTools, readDocument, stableJson, writeDocument,
  type BridgeTool, type Configuration, type Homes, type Project, type ProjectHub, type SecretRedactor, type Thread, type VerificationReport, type VerificationRun } from '@jevellan/core';
import type { BridgeScopeTools } from '@jevellan/conversations';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import type { ThreadGit } from './git.js';
import type { TurnLauncher } from './launch.js';
import { endTurnProcess } from './recovery.js';
import { TurnExecution } from './turn-execution.js';
import { outputTail, runThreadCommand, SETUP_TIMEOUT_MS } from './verification.js';
import { derivedId } from './decision-items.js';
import type { ProjectMemoryPort } from '@jevellan/memory';
import { readSessionMemory } from './memory-tools.js';

export const VERIFICATION_APPEND = 'You are verifying a pull request for this project, in a fresh copy of its branch. Do not change, commit or push anything. Run the existing tests that cover the areas this pull request changed, and for user interface changes the browser specs of those screens at phone and desktop width. Keep it basic: you are checking that the change works and broke nothing nearby, not reviewing the code. End with exactly one jevellan_verification_report.';
const ProcessSchema = TurnProcessSchema.extend({ schema: z.literal('verification-process-v1') });
const refuse = (message: string, status = 403) => Object.assign(new Error(message), { status });

/** A single report, durably saved before acknowledging the call; identical transport retries repeat it. */
export class VerificationTools implements BridgeScopeTools {
  #active = true;
  #pending: Promise<unknown> = Promise.resolve();
  #report: VerificationReport | null;
  readonly abort = new AbortController();
  constructor(readonly save: (report: VerificationReport) => Promise<void>, readonly redactor: SecretRedactor, initial: VerificationReport | null = null, readonly memory?: ProjectMemoryPort) { this.#report = initial; }
  get report() { return this.#report; }
  list() { if (!this.#active) throw refuse('This verification token has expired.', 401); return bridgeTools(this.memory ? ['jevellan_verification_report', 'memory_search', 'memory_read'] : ['jevellan_verification_report']); }
  capture() { return Promise.resolve(BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { queued: false, reason: 'verification' } })); }
  call(name: BridgeTool, raw: unknown) {
    const result = this.#pending.then(async () => {
      this.list();
      if (this.memory && (name === 'memory_search' || name === 'memory_read')) return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: this.redactor.document(await readSessionMemory(this.memory, name, raw, this.redactor, this.abort.signal)) });
      if (name !== 'jevellan_verification_report') throw refuse('Verification can read memory and report its result.');
      const report = VerificationReportSchema.parse(this.redactor.document(raw));
      if (this.#report && stableJson(this.#report) !== stableJson(report)) throw refuse('This verification already reported a different result.', 409);
      if (!this.#report) { await this.save(report); this.#report = report; }
      return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { schema: 'verification-report-receipt-v1', accepted: true } });
    });
    this.#pending = result.then(() => undefined, () => undefined); return result;
  }
  async close() { this.#active = false; this.abort.abort(); await this.#pending; }
}

export class PullRequestVerification {
  readonly #active = new Map<string, { execution?: TurnExecution; controller: AbortController; promise: Promise<VerificationRun | null> }>();
  #closed = false;
  constructor(readonly o: { hub: ProjectHub; homes: Homes; git: ThreadGit; launcher: TurnLauncher; deviceId: string; deviceName?: string; facts?(): DeviceFacts; redactor: SecretRedactor; now(): number;
    settings(): Promise<Configuration['x-jevellan']>; accounts: Pick<AccountService, 'list' | 'recordUsage' | 'recordError'>; runtimes: ReadonlyMap<string, RuntimeAdapter>; timeoutMs: number; memory?(project: Project): ProjectMemoryPort }) {}
  busy() { return this.#active.size > 0; }
  #path(run: VerificationRun) { return this.o.homes.at('worktrees', run.projectId, 'pr-verification', run.id); }
  #process(run: VerificationRun) { return join(this.o.homes.ensure('project-work', run.projectId, 'verification-processes'), `${run.id}.json`); }
  async #save(run: VerificationRun) { return VerificationRunSchema.parse((await this.o.hub.putMergeDocument(VerificationRunSchema.parse(this.o.redactor.document(run)), run.revision)).document); }
  async select(thread: Thread) {
    const [settings, accounts] = await Promise.all([this.o.settings(), this.o.accounts.list()]);
    const eligible = settings.menu.filter(model => model.enabled && model.efforts.includes('medium') && settings.runtimes[model.runtime]?.enabled &&
      this.o.runtimes.get(model.runtime)?.capabilities.turns && rankAccounts({ accounts: accounts.map(view => view.account), statuses: accounts.flatMap(view => view.statuses), runtime: model.runtime, model: model.model, deviceId: this.o.deviceId }).some(entry => entry.eligible && entry.account.runtime === model.runtime));
    const other = eligible.find(model => model.runtime !== thread.placement.runtime);
    const alternate = eligible.find(model => model.runtime === thread.placement.runtime && model.model !== thread.placement.model);
    return other ? { model: other, providerChoice: 'other-provider' as const } : alternate ? { model: alternate, providerChoice: 'different-model' as const } : null;
  }
  async reserve(thread: Thread, commit: string, attempt: number): Promise<VerificationRun | null> {
    const id = derivedId('pver', thread.id, commit, String(attempt)), existing = (await this.o.hub.mergeDocument(id))?.document;
    if (existing?.schema === 'verification-run-v1') return existing;
    const choice = await this.select(thread); if (!choice) return null;
    return this.#save(VerificationRunSchema.parse({ schema: 'verification-run-v1', id, projectId: thread.projectId, threadId: thread.id, commit, revision: 0, deviceId: this.o.deviceId, at: new Date(this.o.now()).toISOString(),
      runtime: choice.model.runtime, modelId: choice.model.id, model: choice.model.model, modelLabel: choice.model.label, providerChoice: choice.providerChoice, state: 'reserved', report: null }));
  }
  execute(run: VerificationRun, thread: Thread, project: Project, repo: string, setupCommand: string): Promise<VerificationRun | null> {
    const existing = this.#active.get(run.id); if (existing) return existing.promise;
    if (this.#closed) return Promise.resolve(null);
    if (!deviceAllowsWork(this.o.homes) || deviceResourceRefusal(this.o.deviceName ?? this.o.deviceId, this.o.facts?.() ?? collectDeviceFacts(this.o.homes))) return Promise.resolve(null);
    const active: { execution?: TurnExecution; controller: AbortController; promise: Promise<VerificationRun | null> } = { controller: new AbortController(), promise: Promise.resolve(null) };
    active.promise = this.#execute(run, thread, project, repo, setupCommand, active).catch(async error => {
      const saved = (await this.o.hub.mergeDocument(run.id))?.document; if (saved?.schema !== 'verification-run-v1') throw error;
      const processPath = this.#process(saved); if (existsSync(processPath)) { await endTurnProcess(readDocument(processPath, ProcessSchema)); rmSync(processPath); }
      if (existsSync(this.#path(saved))) await this.o.git.run(repo, ['worktree', 'remove', '--force', this.#path(saved)]);
      await this.o.git.run(repo, ['update-ref', '-d', `refs/jevellan/verification/${saved.id}`]);
      return this.#save({ ...saved, state: 'failed', note: this.o.redactor.text(error instanceof Error ? error.message : 'Verification setup failed.').slice(0, 1200), endedAt: new Date(this.o.now()).toISOString() });
    }).finally(() => this.#active.delete(run.id));
    this.#active.set(run.id, active); return active.promise;
  }
  async #execute(initial: VerificationRun, thread: Thread, project: Project, repo: string, setupCommand: string, active: { execution?: TurnExecution; controller: AbortController }): Promise<VerificationRun | null> {
    let run = initial; const path = this.#path(run), processPath = this.#process(run), ref = `refs/jevellan/verification/${run.id}`;
    if (run.state === 'passed' || run.state === 'failed') {
      if (existsSync(processPath)) { await endTurnProcess(readDocument(processPath, ProcessSchema)); rmSync(processPath); }
      if (existsSync(path)) await this.o.git.run(repo, ['worktree', 'remove', '--force', path]);
      await this.o.git.run(repo, ['update-ref', '-d', ref]); return run;
    }
    if (run.state === 'running') {
      // A lost worker is never repeated. Keep its worktree while process termination is uncertain.
      if (existsSync(processPath)) { await endTurnProcess(readDocument(processPath, ProcessSchema)); rmSync(processPath); }
      run = await this.#save({ ...run, state: 'failed', note: 'Verification was interrupted by a restart.', endedAt: new Date(this.o.now()).toISOString() });
    } else {
      run = await this.#save({ ...run, state: 'running' });
      await this.o.git.run(repo, ['fetch', '--refmap=', '--no-write-fetch-head', '--no-tags', 'origin', `+refs/pull/${thread.pr!.number}/head:${ref}`], { timeoutMs: 120_000, signal: active.controller.signal });
      if (await this.o.git.resolve(repo, ref) !== run.commit) { run = await this.#save({ ...run, state: 'failed', headMoved: true, note: 'The pull request head changed before verification.', endedAt: new Date(this.o.now()).toISOString() }); await this.o.git.run(repo, ['update-ref', '-d', ref]); return run; }
      mkdirSync(dirname(path), { recursive: true });
      await this.o.git.run(repo, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'worktree', 'add', '--detach', path, run.commit]);
      if (setupCommand) {
        const result = await runThreadCommand(path, setupCommand, { homes: this.o.homes, workId: run.id, timeoutMs: SETUP_TIMEOUT_MS, redactor: this.o.redactor, minimal: true, signal: active.controller.signal,
          onProcess: native => { writeDocument(processPath, ProcessSchema, { schema: 'verification-process-v1', turn: 1, startedAt: new Date(this.o.now()).toISOString(), ...native }); } });
        rmSync(processPath, { force: true });
        if (result.code !== 0 || result.timedOut) run = await this.#save({ ...run, state: 'failed', note: `Verification setup failed. ${outputTail(result, 1000)}`.slice(0, 1200), endedAt: new Date(this.o.now()).toISOString() });
      }
      if (run.state === 'running') {
        if (this.#closed) return null;
        const tools = new VerificationTools(async report => { run = await this.#save({ ...run, report }); }, this.o.redactor, null, this.o.memory?.(project));
        const launched = await this.o.launcher.launch({ owner: { kind: 'verification', projectId: project.id, id: run.id }, turn: 1, runtime: run.runtime, modelId: run.modelId, model: run.model, modelLabel: run.modelLabel,
          effort: 'medium', permissions: 'write', cwd: path, safetyProfile: 'verification', systemAppend: VERIFICATION_APPEND,
          prompt: () => `Verify pull request #${thread.pr!.number}: ${thread.title}\nCommit: ${run.commit}\n\n${thread.lastReport?.summary ?? thread.task}`, tools, timeoutMs: this.o.timeoutMs });
        if (launched.kind === 'unavailable') { await tools.close(); run = await this.#save({ ...run, state: 'failed', note: launched.reason, endedAt: new Date(this.o.now()).toISOString() }); }
        else {
          if (this.#closed) { await launched.run.terminate(); await launched.release(); return null; }
          try {
            active.execution = new TurnExecution({ run: launched.run, accountId: launched.accountId, secretRef: launched.secretRef, model: run.model, deviceId: this.o.deviceId, accounts: this.o.accounts, initialUsage: launched.usage,
              onSession: () => {}, onProcess: native => writeDocument(processPath, ProcessSchema, { schema: 'verification-process-v1', turn: 1, startedAt: new Date(this.o.now()).toISOString(), ...native }), redactor: this.o.redactor });
            const outcome = await active.execution.done;
            // TurnExecution only resolves after the entire owned process group is gone.
            rmSync(processPath, { force: true });
            const report = tools.report;
            let note = outcome.status !== 'completed' ? `Verification ${outcome.status}: ${outcome.error?.message ?? 'The session did not complete.'}` : !report ? 'Verification ended without its required report.' : undefined;
            const head = await this.o.git.resolve(path, 'HEAD'), dirty = (await this.o.git.run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
            if (head !== run.commit || dirty) note = 'Verification changed its worktree or created a commit.';
            run = await this.#save({ ...run, state: note ? 'failed' : report!.result, report, ...(note ? { note: this.o.redactor.text(note).slice(0, 1200) } : {}), endedAt: new Date(this.o.now()).toISOString() });
          } finally { await launched.release(); }
        }
      }
    }
    if (existsSync(path)) await this.o.git.run(repo, ['worktree', 'remove', '--force', path]);
    await this.o.git.run(repo, ['update-ref', '-d', ref]);
    return run;
  }
  async close() { this.#closed = true; await Promise.allSettled([...this.#active.values()].map(async active => { active.controller.abort(); await active.execution?.shutdown(); await active.promise; })); }
}
