import { CheckEnvironmentBlocked, ProjectCheckWorkspace, checkInputSnapshot, checkEnvironmentProfile, type CheckInputSnapshot } from './check-environment.js';
import type { ProjectEnvSecretSummary } from '@jevellan/core';
import {applyJevRouteRules,projectJevLessons,parseLandingPrompt,landingPromptText} from '@jevellan/decisions';
import { routeWhyView } from './route-why.js';
import { deliveryDirectory, JobGateResultSchema, PrivateJobDeliverySchema } from './job-deliveries.js';
import { readDocument, writeDocument } from '@jevellan/core';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { decideLandingRoute, type DecisionSource, type LandingPrompt } from '@jevellan/decisions';
import { LandingRouteSchema, LandingCorrectionInputSchema, LandingCorrectionSchema, MergeDocumentsViewSchema, ProjectDecisionSchema, PUBLICATION_BUSY, stableJson, withPublicationLease,
  type Configuration, type DecisionAnswer, type Homes, type ProjectLedgerEvent, type LandingRoute, type Project, type ProjectDecision, type ProjectHub,
  type ProjectWorkSettings, type MergeDocument, type PublicationLeaseService, type SecretRedactor, type Thread, type ThreadLanding } from '@jevellan/core';
import { derivedId, systemWithdrawal } from './decision-items.js';
import { GIT_NETWORK_TIMEOUT_MS, type ThreadGit } from './git.js';
import type { ThreadStore } from './stores.js';
import type { GitHubAccess, ThreadPublication } from './publication.js';
import type { PullRequestVerification } from './pr-verification.js';
import { outputTail, SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS } from './verification.js';

export const pathMatches = (file: string, path: string): boolean => file === path.replace(/\/$/u, '') || file.startsWith(path.replace(/\/$/u, '') + '/');
export function selectedLandingChecks(settings: Pick<ProjectWorkSettings, 'landingChecks' | 'smokeCheck'>, files: readonly string[]) {
  return [...settings.landingChecks.filter(check => !check.paths.length || files.some(file => check.paths.some(path => pathMatches(file, path)))),
    ...(settings.smokeCheck ? [{ name: 'Smoke check', paths: [], command: settings.smokeCheck }] : [])];
}
export type LandingOutcome = { kind: 'landed'; landing: ThreadLanding; routeId: string } | { kind: 'no-changes' }
  | { kind: 'fix'; reason: 'conflict'; body: string }
  | { kind: 'fix'; reason: 'verification'; body: string; tail?: string; failureFingerprint: string } | { kind: 'waiting'; reason: string };
/** Exact failure data only: timestamps and candidate commits do not change a failed command's identity. */
function failureFingerprint(value: unknown, redactor: SecretRedactor): string {
  return createHash('sha256').update(redactor.text(stableJson(value))).digest('hex');
}
/** The port a failed check could not bind because another process held it, from the check's output. */
export function heldPort(output: string): number | null {
  const match = /EADDRINUSE[^\n]*?:(\d{2,5})\b/u.exec(output) ?? /\bport\s+(\d{2,5})\b[^\n]{0,80}?\b(?:already in use|in use|is held|held by|busy|occupied)/iu.exec(output);
  const port = match ? Number(match[1]) : NaN; return port > 0 && port < 65536 ? port : null;
}
async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = connect({ port, host: '127.0.0.1', timeout: 2000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('timeout', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(false));
  });
}
/** Who listens on a TCP port, when the device's process discovery tools can name it. */
export async function portHolder(port: number): Promise<{ pid?: number; command?: string } | null> {
  if (!await portAcceptsConnections(port)) return null;
  const run = (file: string, args: string[]) => promisify(execFile)(file, args, { timeout: 3000, encoding: 'utf8' }).then(result => result.stdout, () => '');
  const lsof = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  const pid = /^p(\d+)$/mu.exec(lsof)?.[1], command = /^c(.+)$/mu.exec(lsof)?.[1];
  if (pid) return { pid: Number(pid), ...(command ? { command } : {}) };
  const ss = /users:\(\("([^"]+)",pid=(\d+)/u.exec(await run('ss', ['-ltnpH', `sport = :${port}`]));
  return ss ? { pid: Number(ss[2]), command: ss[1]! } : {};
}
const holderText = (holder: { pid?: number; command?: string }) => holder.pid ? `${holder.command ?? 'a process'} (pid ${holder.pid})` : 'another process';
const failure = (error: unknown, redactor: SecretRedactor) => redactor.text(error instanceof Error ? error.message : 'Landing failed.').slice(0, 1200);

/** Checked code reaches main under the hub's renewable publication lease. No agent performs this operation. */
export type LandingJev = { version: number; prompt: LandingPrompt; lessons: { ids: string[]; texts: string[]; keys?: string[]; input?: import('@jevellan/core').JevLessonInput };
  apply(route: 'land' | 'verify-then-land' | 'ask-owner', thread: Thread): { route: 'land' | 'verify-then-land' | 'ask-owner'; rulesApplied: string[]; reason: string } };
export class ThreadLandingService {
  readonly #legacyChecked = new Map<string, string>();
  constructor(readonly o: { homes: Homes; git: ThreadGit; github: GitHubAccess; publication: ThreadPublication; hub: ProjectHub; store: ThreadStore;
    verification: PullRequestVerification; leases?: PublicationLeaseService; deviceId: string; redactor: SecretRedactor; now(): number;
    settings(projectId: string): Promise<ProjectWorkSettings>; configuration(): Promise<Configuration['x-jevellan']>; decisionClient?: DecisionSource;
    projectEnvironment?(projectId: string): Promise<Record<string, string>>; checkCredentials?(projectId: string): Promise<Record<string, string>>; checkSecretSummary?(projectId: string, name: string): Promise<ProjectEnvSecretSummary>; project?(projectId: string): Promise<Project>; assertLanding(projectId: string, threadId: string): Promise<void>;
    retry(projectId: string, threadId: string): Promise<void>;
    /** Jev control (bridge): the active l-v1 prompt, the lessons Jev reads, and the owner's rules applied after its answer. */
    jev?(projectId: string): Promise<LandingJev | undefined> }) {}
  async #snapshot(project: Project, thread: Thread, settings: ProjectWorkSettings) {
    checkEnvironmentProfile(settings);
    const root = project.paths[this.o.deviceId];
    if (settings.checkEnvironment?.copyFiles.length && !root) throw new CheckEnvironmentBlocked('The check environment needs the registered project checkout.');
    return checkInputSnapshot({ settings, projectRoot: root ?? thread.cwd, ...(this.o.checkSecretSummary ? { summary: name => this.o.checkSecretSummary!(project.id, name) } : {}) });
  }
  async #policy(project: Project, thread: Thread, settings: ProjectWorkSettings) {
    let snapshot: CheckInputSnapshot | undefined, blocked: CheckEnvironmentBlocked | undefined;
    try { snapshot = await this.#snapshot(project, thread, settings); }
    catch (error) { if (!(error instanceof CheckEnvironmentBlocked)) throw error; blocked = error; }
    const digest = createHash('sha256').update(stableJson({ schema: 'isolated-check-policy-v1', checks: settings.landingChecks, ports: settings.landingPorts,
      smoke: settings.smokeCheck, merge: settings.mergeCommitPaths, setup: settings.setupCommand, profile: settings.checkEnvironment,
      inputs: snapshot?.identity ?? { blocked: blocked!.message } })).digest('hex');
    return { digest, snapshot, blocked };
  }
  async #environmentReady(thread: Thread): Promise<boolean> {
    try {
      const settings = await this.o.settings(thread.projectId), profile = checkEnvironmentProfile(settings), project = await this.o.project?.(thread.projectId);
      const root = project?.paths[this.o.deviceId]; if (profile.copyFiles.length && !root) return false;
      await checkInputSnapshot({ settings, projectRoot: root ?? thread.cwd, ...(this.o.checkSecretSummary ? { summary: name => this.o.checkSecretSummary!(thread.projectId, name) } : {}) });
      return true;
    } catch (error) { if (error instanceof CheckEnvironmentBlocked) return false; throw error; }
  }
  async waitForEnvironment(thread: Thread, reason: string) {
    const commit = await this.o.git.resolve(thread.cwd, 'HEAD'); if (!commit) return { kind: 'waiting' as const, reason };
    const old = this.o.store.local(thread.id).landingWait;
    if (old?.blocker.kind === 'port') {
      if (!old.blocker.managed && await portAcceptsConnections(old.blocker.port)) return { kind: 'waiting' as const, reason };
      await this.#clearWait(thread, `The blocking port ${old.blocker.port} is free; the check environment still needs attention.`);
    }
    const current = this.o.store.local(thread.id).landingWait;
    const same = current?.blocker.kind === 'environment' && current.blocker.commit === commit;
    // A newer candidate does not silently close a still-unavailable environment question.
    const sequence = (this.o.store.local(thread.id).landingWaitSequence ?? 0) + (same || current?.blocker.kind === 'environment' ? 0 : 1);
    const decisionId = current?.blocker.kind === 'environment' ? current.decisionId : derivedId('pdec', 'check-environment', thread.id, String(sequence));
    const wait = { schema: 'thread-landing-wait-v1' as const, blocker: { schema: 'landing-environment-blocker-v1' as const, kind: 'environment' as const, commit, check: 'Check environment' },
      decisionId, reason: current?.blocker.kind === 'environment' ? current.reason : reason.slice(0, 1200), createdAt: current?.blocker.kind === 'environment' ? current.createdAt : new Date(this.o.now()).toISOString() };
    this.o.store.updateLocal(thread.id, local => ({ ...local, landingWaitSequence: sequence, landingWait: wait }));
    await this.#ensureWaitQuestion(thread, wait); return { kind: 'waiting' as const, reason };
  }
  async environmentAvailable(thread: Thread) {
    if (this.o.store.local(thread.id).landingWait?.blocker.kind === 'environment') await this.#clearWait(thread, 'The separate check environment is available; verification resumes.');
  }
  /** Recover only a still-current typed resource failure. New owner work and decisions always win. */
  async #recoverLegacyWait(thread: Thread) {
    if (thread.state !== 'idle' || thread.landing || thread.resolution || thread.endedAt || thread.lastReport?.status !== 'done' || thread.queuedMessages.length || this.o.store.local(thread.id).landingWait) return;
    const token = this.o.store.current(thread.id)?.index.updatedAt ?? thread.createdAt;
    if (this.#legacyChecked.get(thread.id) === token) return; this.#legacyChecked.set(thread.id, token);
    const settings = await this.o.settings(thread.projectId); if (settings.status !== 'active' || !settings.autoLand) return;
    const ledger = this.o.store.ledgers.thread(thread.projectId, thread.id);
    let changedAt = thread.createdAt;
    const changes = ledger.events();
    for (let index = changes.length - 1; index >= 0; index--) {
      if (index % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      const event = changes[index]!; if (event.type !== 'thread-state') continue;
      const state = ledger.payload(event as ProjectLedgerEvent & { type: 'thread-state' });
      if (state.from !== state.to || (state.changed ?? []).some(field => field !== 'fixable' && field !== 'usage')) { changedAt = event.t; break; }
    }
    const coordinator = this.o.store.ledgers.coordinator(thread.projectId), events = coordinator.events();
    let failed: { at: string; tail: string } | undefined;
    for (let index = events.length - 1; index >= 0; index--) {
      if (index % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      const event = events[index]!; if (event.type !== 'coordinator-event') continue;
      const value = coordinator.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' });
      if (value.kind === 'thread-verification-failed' && value.threadId === thread.id && value.attempts >= 3) { failed = value; break; }
    }
    if (!failed || Date.parse(failed.at) < Date.parse(changedAt)) return;
    const port = heldPort(failed.tail); if (port === null) return;
    const routes = (await this.records(thread.projectId, thread.id)).filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
    if (routes[0]?.state === 'asked') return;
    const commit = await this.o.git.resolve(thread.cwd, 'HEAD');
    if (!commit || (await this.o.git.run(thread.cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout) return;
    const holder = await portHolder(port);
    const reason = this.o.redactor.text(`Landing checks wait on port ${port}${holder ? ` held by ${holderText(holder)}` : ', now free'}. The checked landing retries when this resource is available.`);
    await this.#waitForPort(thread, 'Landing checks', commit, port, reason, false);
    this.o.store.update(thread.id, current => ({ ...current, state: 'in-review', stateReason: reason.slice(0, 400) }));
  }
  async #clearWait(thread: Thread, reason: string) {
    const wait = this.o.store.local(thread.id).landingWait; if (!wait) return;
    const decision = (await this.o.hub.decision(wait.decisionId))?.document;
    if (decision && !decision.answer && !decision.withdrawnAt) await this.o.hub.withdrawDecision(decision.id, new Date(this.o.now()).toISOString(), {
      schema: 'project-decision-withdrawal-v1', source: 'system', reason });
    this.o.store.updateLocal(thread.id, current => { const next = { ...current }; delete next.landingWait; return next; });
  }
  async #ensureWaitQuestion(thread: Thread, wait: NonNullable<ReturnType<ThreadStore['local']>['landingWait']>) {
    if (!(await this.o.hub.decision(wait.decisionId))) await this.o.hub.createDecision(ProjectDecisionSchema.parse({ schema: 'project-decision-v1', id: wait.decisionId, projectId: thread.projectId,
      revision: 0, threadId: thread.id, from: 'thread', blocker: wait.blocker, question: wait.reason, options: [{ label: 'Retry checks' }, { label: 'Keep waiting' }], createdAt: wait.createdAt }));
  }
  async #waitForPort(thread: Thread, check: string, commit: string, port: number, reason: string, managed: boolean) {
    const old = this.o.store.local(thread.id).landingWait;
    const same = old?.blocker.kind === 'port' && old.blocker.commit === commit && old.blocker.check === check && old.blocker.port === port;
    if (old && !same) await this.#clearWait(thread, 'A newer checked candidate replaced this landing resource wait.');
    const sequence = (this.o.store.local(thread.id).landingWaitSequence ?? 0) + (same ? 0 : 1);
    const decisionId = same ? old.decisionId : derivedId('pdec', 'landing-blocker', thread.id, commit, check, String(port), String(sequence));
    const blocker = { schema: 'landing-blocker-v1' as const, kind: 'port' as const, port, commit, check, ...(managed ? { managed: true } : {}) };
    const wait = { schema: 'thread-landing-wait-v1' as const, blocker, decisionId, reason, createdAt: same ? old.createdAt : new Date(this.o.now()).toISOString() };
    this.o.store.updateLocal(thread.id, current => ({ ...current, landingWaitSequence: sequence, landingWait: wait }));
    await this.#ensureWaitQuestion(thread, wait);
    return { kind: 'waiting' as const, reason };
  }
  async records(projectId: string, threadId?: string) {
    const rows: MergeDocument[] = []; let after: string | undefined;
    do { const page = await this.o.hub.mergeDocuments(projectId, after, threadId); rows.push(...page.records); after = page.next ?? undefined; } while (after);
    return rows;
  }
  async view(projectId: string, threadId: string) { return MergeDocumentsViewSchema.parse({ schema: 'merge-documents-view-v1', records: await this.records(projectId, threadId) }); }
  async whyView(projectId: string, threadId: string, saved = false) { return routeWhyView({ kind: 'landing', projectId, threadId, records: await this.records(projectId, threadId), saved }); }
  async correct(projectId: string, threadId: string, raw: unknown) {
    const input = LandingCorrectionInputSchema.parse(raw), thread = (await this.o.hub.thread(threadId))?.document;
    if (!thread || thread.projectId !== projectId) throw new Error('Thread not found.');
    if (!(await this.records(projectId, threadId)).some(row => row.schema === 'landing-route-v1' && row.commit === input.commit)) throw new Error('This thread has no landing route at that commit.');
    await this.o.hub.putMergeDocument(LandingCorrectionSchema.parse({ schema: 'landing-correction-v1', id: derivedId('lcor', projectId, threadId, input.clientRequestId), projectId, threadId, revision: 0, deviceId: this.o.deviceId, commit: input.commit, title: thread.title, correction: input.correction, at: new Date(this.o.now()).toISOString() }), 0);
    return this.view(projectId, threadId);
  }
  async #save(route: LandingRoute) { return LandingRouteSchema.parse((await this.o.hub.putMergeDocument(LandingRouteSchema.parse(this.o.redactor.document(route)), route.revision)).document); }
  async #ask(route: LandingRoute, thread: Thread) {
    const id = route.decisionId ?? derivedId('pdec', 'landing', route.id);
    if (!(await this.o.hub.decision(id))) await this.o.hub.createDecision(ProjectDecisionSchema.parse({ schema: 'project-decision-v1', id, projectId: thread.projectId, revision: 0,
      threadId: thread.id, from: 'thread', question: `Land "${thread.title}" on main at ${route.commit.slice(0, 7)}? ${route.reason ?? ''}`.slice(0, 2000),
      options: [{ label: 'Land now' }, { label: 'Leave it' }], landing: { routeId: route.id, commit: route.commit }, createdAt: new Date(this.o.now()).toISOString() }));
    return this.#save({ ...route, decisionId: id, state: 'asked' });
  }
  async answer(decision: ProjectDecision, answer: DecisionAnswer, validateOnly: boolean): Promise<boolean> {
    if (decision.blocker && decision.threadId) {
      if (!this.o.store.get(decision.threadId)) throw new Error('This landing item belongs on the thread’s device.');
      const wait = this.o.store.local(decision.threadId).landingWait;
      if (answer.optionLabel !== 'Retry checks' && answer.optionLabel !== 'Keep waiting') throw new Error('Choose a landing blocker option.');
      if (!wait || wait.decisionId !== decision.id || wait.blocker.kind !== decision.blocker.kind || wait.blocker.kind === 'port' && wait.blocker.commit !== decision.blocker.commit || wait.blocker.kind === 'port' && decision.blocker.kind === 'port' && wait.blocker.port !== decision.blocker.port) {
        if (decision.answer) return true;
        throw new Error('This landing blocker changed. Reload it.');
      }
      if (validateOnly || answer.optionLabel === 'Keep waiting') return true;
      if (wait.blocker.kind === 'environment') {
        if (!await this.#environmentReady(this.o.store.get(decision.threadId)!)) return true;
      } else {
        if (!wait.blocker.managed && await portAcceptsConnections(wait.blocker.port)) return true;
        await this.#clearWait(this.o.store.get(decision.threadId)!, wait.blocker.managed ? 'Fresh managed localhost ports will be allocated for the retry.' : `The blocking port ${wait.blocker.port} is now free; landing checks resume.`);
      }
      await this.o.retry(decision.projectId, decision.threadId);
      return true;
    }
    if (!decision.landing || !decision.threadId) return false;
    if (!this.o.store.get(decision.threadId)) throw new Error('This landing item belongs on the thread’s device.');
    const route = (await this.o.hub.mergeDocument(decision.landing.routeId))?.document;
    if (route?.schema !== 'landing-route-v1' || route.threadId !== decision.threadId || route.commit !== decision.landing.commit) throw new Error('This landing decision changed. Reload it.');
    if (answer.optionLabel !== 'Land now' && answer.optionLabel !== 'Leave it') throw new Error('Choose a landing option.');
    if (validateOnly) return true;
    if (answer.optionLabel === 'Leave it') { this.o.store.update(decision.threadId, current => ({ ...current, state: 'idle', stateReason: 'Landing left by the owner.' })); return true; }
    await this.#save({ ...route, route: 'land', source: 'owner', state: 'waiting', reason: 'The owner chose Land now.' });
    await this.o.retry(decision.projectId, decision.threadId); return true;
  }
  /** The owner overrides Jev's route before landing (bridge `override`): the latest route takes the owner's choice and landing retries. */
  async ownerRoute(projectId: string, threadId: string, choice: 'land' | 'verify-then-land' | 'ask-owner'): Promise<boolean> {
    const rows = (await this.records(projectId, threadId)).filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
    const route = rows[0]; if (!route || route.state === 'landed') return false;
    if (route.decisionId) { const item = (await this.o.hub.decision(route.decisionId))?.document; if (item && !item.answer && !item.withdrawnAt) await this.o.hub.withdrawDecision(item.id, new Date(this.o.now()).toISOString(), systemWithdrawal('The owner selected a replacement landing route.')); }
    await this.#save({ ...route, source: 'owner', route: choice, state: 'waiting', reason: `The owner chose ${choice}.` });
    if (this.o.store.get(threadId)) await this.o.retry(projectId, threadId);
    return true;
  }
  async override(thread: Thread) {
    const rows = (await this.records(thread.projectId, thread.id)).filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
    const route = rows[0]; if (route) {
      if (route.decisionId) { const item = (await this.o.hub.decision(route.decisionId))?.document; if (item && !item.answer) await this.o.hub.withdrawDecision(item.id, new Date(this.o.now()).toISOString(), systemWithdrawal('The owner selected a replacement landing route.')); }
      await this.#save({ ...route, source: 'owner', route: 'land', state: 'waiting', reason: 'The owner chose Land now.' });
    }
  }
  async #files(thread: Thread, base: string) {
    const paths = (await this.o.git.run(thread.cwd, ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`])).stdout.split('\0').filter(Boolean);
    const stats = (await this.o.git.run(thread.cwd, ['diff', '--numstat', '--no-renames', '-z', `${base}...HEAD`])).stdout.split('\0').filter(Boolean);
    const changes = new Map(stats.map(row => { const [a, d, ...name] = row.split('\t'); return [name.join('\t'), { additions: Number(a) || 0, deletions: Number(d) || 0 }]; }));
    return Promise.all(paths.map(async path => ({ path, ...(changes.get(path) ?? { additions: 0, deletions: 0 }), bytes: Number((await this.o.git.run(thread.cwd, ['cat-file', '-s', `HEAD:${path}`], { permitted: [1, 128] })).stdout.trim()) || 0 })));
  }
  async #delivery(thread: Thread) {
    const bound = async (task: import('@jevellan/core').ProjectWorkTask) => {
      if (!task.jobDelivery) return null;
      const run = (await this.o.hub.jobRun(task.jobDelivery.runId))?.document, delivery = run?.deliveries?.find(row => row.id === task.jobDelivery!.deliveryId);
      if (!run || run.projectId !== thread.projectId || !delivery) throw new Error('The job delivery receipt is unavailable.');
      return { run, delivery };
    };
    if (thread.taskContext?.taskId) {
      const task = (await this.o.hub.task(thread.taskContext.taskId))?.document;
      if (!task || task.projectId !== thread.projectId) throw new Error('The originating task is unavailable.');
      return bound(task);
    }
    let after: string | undefined;
    do { const page = await this.o.hub.tasks(thread.projectId, after); const task = page.records.find(row => row.threadId === thread.id && row.jobDelivery); if (task) return bound(task); after = page.next ?? undefined; } while (after);
    return null;
  }
  async #gate(thread: Thread, settings: ProjectWorkSettings, base: string, head: string, files: string[], candidate: ProjectCheckWorkspace, snapshot: CheckInputSnapshot, signal?: AbortSignal) {
    const bound = await this.#delivery(thread); if (!bound?.delivery.gate) return null;
    const { run, delivery } = bound, gate = delivery.gate!;
    if (run.deviceId !== this.o.deviceId) throw new Error('This landing needs the device holding its private job input.');
    if (files.some(file => gate.protectedPaths.some(path => pathMatches(file, path)))) throw new Error('The candidate changed a protected evaluation path.');
    const directory = deliveryDirectory(this.o.homes, thread.projectId, run.id), inputFile = join(directory, `${delivery.id}.json`), input = readDocument(inputFile, PrivateJobDeliverySchema);
    if (input.sha256 !== delivery.inputSha256 || input.trustedCommit !== run.commit || input.runId !== run.id || input.deliveryId !== delivery.id) throw new Error('The private gate input does not match its job receipt.');
    const trusted = await ProjectCheckWorkspace.create({ homes: this.o.homes, git: this.o.git, redactor: this.o.redactor, projectId: thread.projectId, workId: thread.id,
      cwd: thread.cwd, commit: run.commit, snapshot, secrets: await this.o.checkCredentials?.(thread.projectId) ?? {}, ...(settings.landingPorts ? { ports: settings.landingPorts } : {}), ...(signal ? { signal } : {}) });
    let receipt: ReturnType<typeof JobGateResultSchema.parse>;
    try {
      const resultFile = join(trusted.root, 'project-job-gate-result.json'), gateInput = join(trusted.root, 'private-input.json');
      writeDocument(gateInput, PrivateJobDeliverySchema, input);
      const result = await trusted.run(gate.command, { timeoutMs: gate.timeoutMinutes * 60000, ...(signal ? { signal } : {}),
        gitEnv: { JEVELLAN_GATE_INPUT: gateInput, JEVELLAN_GATE_CANDIDATE: candidate.cwd, JEVELLAN_GATE_CANDIDATE_COMMIT: head, JEVELLAN_GATE_BASE_COMMIT: base, JEVELLAN_GATE_RESULT: resultFile },
        jobContext: { schema: 'project-job-context-v1', purpose: 'check', projectId: run.projectId, runId: run.id, jobId: run.jobId, workspace: trusted.root, commandCheckout: trusted.cwd, commit: run.commit } });
      if (result.code !== 0 || result.timedOut || !existsSync(resultFile) || !await trusted.clean() || !await candidate.clean()) throw new Error(`The trusted job gate did not pass: ${outputTail(result, 2000)}`);
      receipt = readDocument(resultFile, JobGateResultSchema);
      if (!receipt.passed || receipt.checks.some(row => !row.passed) || receipt.trustedCommit !== run.commit || receipt.candidateCommit !== head || await this.o.git.resolve(thread.cwd, 'HEAD') !== head) throw new Error('The trusted job gate refused this candidate.');
    } finally { await trusted.close(); }
    if (receipt.validUntil && Date.parse(receipt.validUntil) <= this.o.now()) throw new Error('The required job gate deadline expired. This work needs a fresh measured delivery.');
    return { check: { name: gate.id, passed: true, at: new Date(this.o.now()).toISOString() }, validUntil: receipt.validUntil };
  }
  async #expired(route: LandingRoute, validUntil: string | undefined): Promise<LandingOutcome | null> {
    if (!validUntil || Date.parse(validUntil) > this.o.now()) return null;
    const reason = 'The required job gate deadline expired. This work needs a fresh measured delivery.';
    await this.#save({ ...route, state: 'failed', reason });
    return { kind: 'waiting', reason };
  }
  async #prepare(project: Project, thread: Thread, settings: ProjectWorkSettings, base: string, signal?: AbortSignal) {
    const rebase = await this.o.git.run(thread.cwd, ['rebase', base], { permitted: [1], ...(signal ? { signal } : {}) });
    if (rebase.code !== 0) {
      const files = (await this.o.git.run(thread.cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean);
      await this.o.git.run(thread.cwd, ['rebase', '--abort']);
      return { kind: 'fix' as const, reason: 'conflict' as const, body: `Landing stopped: main moved and these files conflict: ${files.join(', ')}. Run git fetch origin and git rebase origin/${thread.baseBranch} in your worktree, resolve the conflicts keeping the intent of both sides, run the relevant tests and report done.` };
    }
    const files = await this.#files(thread, base), checks: ThreadLanding['checks'] = [], selected = selectedLandingChecks(settings, files.map(file => file.path));
    const head = (await this.o.git.resolve(thread.cwd, 'HEAD'))!, gateNeeded = !!(await this.#delivery(thread))?.delivery.gate;
    if (!selected.length && !gateNeeded) return { kind: 'checked' as const, files, checks, head, gateValidUntil: undefined };
    const snapshot = await this.#snapshot(project, thread, settings);
    const workspace = await ProjectCheckWorkspace.create({ homes: this.o.homes, git: this.o.git, redactor: this.o.redactor, projectId: thread.projectId, workId: thread.id,
      cwd: thread.cwd, commit: head, snapshot, secrets: await this.o.checkCredentials?.(thread.projectId) ?? {}, ...(settings.landingPorts ? { ports: settings.landingPorts } : {}), ...(signal ? { signal } : {}) });
    await this.environmentAvailable(thread);
    try {
      const commands = [...(settings.setupCommand ? [{ name: 'Check setup', command: settings.setupCommand, timeoutMs: SETUP_TIMEOUT_MS }] : []), ...selected.map(check => ({ ...check, timeoutMs: TEST_TIMEOUT_MS }))];
      for (const check of commands) {
        const result = await workspace.run(check.command, { timeoutMs: check.timeoutMs, ...(signal ? { signal } : {}) });
        const passed = result.code === 0 && !result.timedOut && await this.o.git.resolve(thread.cwd, 'HEAD') === head && await workspace.clean();
        checks.push({ name: check.name, passed, at: new Date(this.o.now()).toISOString() });
        const port = passed || result.timedOut ? null : heldPort(outputTail(result, 8000)), holder = port === null ? null : await portHolder(port);
        if (port !== null && holder) return this.#waitForPort(thread, check.name, head, port, this.o.redactor.text(`${check.name} could not start: port ${port} is in use by ${holderText(holder)}. It lands by itself once the port is free.`), workspace.ports.includes(port));
        if (!passed) { const tail = this.o.redactor.text(outputTail(result, 4000) || 'The check changed its candidate checkout or commit.'); return { kind: 'fix' as const, reason: 'verification' as const, tail,
          failureFingerprint: failureFingerprint({ kind: 'landing-check', command: check.command, name: check.name, code: result.code, timedOut: result.timedOut, tail }, this.o.redactor),
          body: `Landing checks failed (attempt ${thread.verificationAttempts + 1} of 3). ${check.name}: ${tail}. Fix the cause, run the relevant tests and report done.` }; }
      }
      const gate = await this.#gate(thread, settings, base, head, files.map(file => file.path), workspace, snapshot, signal); if (gate) checks.push(gate.check);
      if ((await this.#snapshot(project, thread, await this.o.settings(project.id))).identity !== snapshot.identity) throw new CheckEnvironmentBlocked('The check environment changed during verification; checks will retry.');
      await this.#clearWait(thread, 'The landing checks passed; their resource wait is resolved.');
      return { kind: 'checked' as const, files, checks, head, gateValidUntil: gate?.validUntil };
    } finally { await workspace.close(); }
  }
  async publish(project: Project, thread: Thread, signal?: AbortSignal, priorState = thread.state): Promise<LandingOutcome> {
    try {
      const leases = this.o.leases; if (!leases) return { kind: 'waiting', reason: 'The state point’s publication lease is unavailable.' };
      await this.o.assertLanding(project.id, thread.id);
      const local = this.o.store.local(thread.id);
      await this.o.git.commitAll(thread.cwd, thread.title, local.gitIdentity, local.copiedFiles);
      for (const commit of (await this.o.git.run(thread.cwd, ['rev-list', `${thread.baseCommit}..HEAD`])).stdout.trim().split('\n').filter(Boolean)) {
        if (!local.copiedFiles?.length) break;
        const copied = (await this.o.git.run(thread.cwd, ['--literal-pathspecs', 'diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', '-z', commit, '--', ...local.copiedFiles])).stdout.split('\0').filter(Boolean);
        if (copied.length) return { kind: 'fix', reason: 'verification', failureFingerprint: failureFingerprint({ kind: 'copied-files', paths: [...copied].sort() }, this.o.redactor),
          body: `Landing checks failed (attempt ${thread.verificationAttempts + 1} of 3). Copied files: remove ${copied.join(', ')} from this branch's commits. Fix the cause, run the relevant tests and report done.` };
      }
      await this.o.publication.backupWorktree(thread, signal);
      const remote = await this.o.git.remoteUrl(thread.cwd); if (!remote) return { kind: 'waiting', reason: 'Landing needs a git remote.' };
      const ref = `refs/jevellan/threads/${thread.id}/landing-base`;
      let base = await this.o.git.fetchPrivate(thread.cwd, thread.baseBranch, ref, signal);
      const records = await this.records(project.id, thread.id), currentHead = await this.o.git.resolve(thread.cwd, 'HEAD');
      // A pushed candidate is durable before its transport acknowledgement. Recover it even if another landing followed.
      for (const old of records) if (old.schema === 'landing-route-v1' && old.checkedCommit === currentHead && old.candidate && (await this.o.git.run(thread.cwd, ['merge-base', '--is-ancestor', old.candidate.commit, base], { permitted: [1] })).code === 0) return { kind: 'landed', landing: old.candidate, routeId: old.id };
      if (!(await this.o.git.run(thread.cwd, ['diff', '--name-only', `${base}...HEAD`])).stdout) return { kind: 'no-changes' };
      const settings = await this.o.settings(project.id);
      const settingsDigest = (await this.#policy(project, thread, settings)).digest, head = await this.o.git.resolve(thread.cwd, 'HEAD');
      const gated = !!(await this.#delivery(thread))?.delivery.gate;
      const cached = records.find((row): row is LandingRoute => row.schema === 'landing-route-v1' && row.checkedCommit === head && row.baseCommit === base && row.settingsDigest === settingsDigest && row.packet.checks.every(check => check.passed) && (!gated || !!row.gateValidUntil && Date.parse(row.gateValidUntil) > this.o.now()));
      const ready = cached ? { kind: 'checked' as const, files: cached.packet.files, checks: cached.packet.checks, head: cached.checkedCommit!, gateValidUntil: cached.gateValidUntil } : await this.#prepare(project, thread, settings, base, signal); if (ready.kind !== 'checked') return ready;
      const id = derivedId('lroute', thread.id, ready.head); let route = (await this.o.hub.mergeDocument(id))?.document;
      if (route && route.schema !== 'landing-route-v1') throw new Error('This landing receipt has another schema.');
      if (!route) {
        for (const old of records) if (old.schema === 'landing-route-v1' && old.commit !== ready.head && old.decisionId) { const item = (await this.o.hub.decision(old.decisionId))?.document; if (item && !item.answer && !item.withdrawnAt) await this.o.hub.withdrawDecision(item.id, new Date(this.o.now()).toISOString(), systemWithdrawal('A newer commit replaced this landing candidate.')); }
        const corrections = (await this.records(project.id)).filter(row => row.schema === 'merge-correction-v1' || row.schema === 'landing-correction-v1')
          .sort((a, b) => b.at.localeCompare(a.at) || (('receivedOrder' in b ? b.receivedOrder : 0) ?? 0) - (('receivedOrder' in a ? a.receivedOrder : 0) ?? 0)).slice(0, 8)
          .map(row => 'correction' in row ? `For “${row.title}”, the owner said: ${row.correction === 'should-have-asked' ? 'Should have asked me' : "Didn't need asking"}.` : '');
        const packet = { schema: 'landing-route-state-v1' as const, title: thread.title, task: thread.taskContext ?? { type: 'feature' as const, needs: [], goal: null }, summary: (thread.lastReport?.summary ?? '').slice(0, 4000), files: ready.files, checks: ready.checks, riskyAreas: settings.riskyAreas, corrections };
        let jev:LandingJev|undefined,policyFailed=false;
        try{
          jev=await this.o.jev?.(project.id);
          if(!jev&&settings.jevPolicy){const policy=settings.jevPolicy,version=policy.prompts?.find(row=>row.name==='l-v1'&&row.active);
            if(version){const lessons=projectJevLessons(project.id,policy.lessons);jev={version:version.version,prompt:parseLandingPrompt(version.text),lessons:{ids:lessons.ids,keys:lessons.keys,texts:lessons.corrections.map(row=>row.text),...(lessons.input?{input:lessons.input}:{})},apply:(route,thread)=>applyJevRouteRules(project.id,route,policy.rules,{taskType:thread.taskContext?.type??'feature',...(thread.taskContext?.goal?.id?{goalId:thread.taskContext.goal.id}:{}),label:thread.taskContext?.goal?.name??'manual',text:`${thread.title} ${thread.task}`})};}
          }
        }catch{policyFailed=true;}
        const asked=jev?{...packet,corrections:jev.lessons.texts.slice(0,8).map(text=>this.o.redactor.text(text).slice(0,500)),...(jev.lessons.input?{lessons:jev.lessons.input}:{})}:packet;
        const answered = await decideLandingRoute(this.o.decisionClient, asked, async () => (await this.o.configuration()).decisions.model, this.o.redactor, signal ?? new AbortController().signal, policyFailed?()=>{throw Error('The canonical landing policy is unavailable.');}:jev?.prompt);
        const ruled = answered.source === 'jev' && jev ? jev.apply(answered.route, thread) : undefined;
        const condition = { taskType: thread.taskContext?.type ?? 'feature', ...(thread.taskContext?.goal?.id ? { goalId: thread.taskContext.goal.id } : {}), label: thread.taskContext?.goal?.name ?? 'manual', text: `${thread.title} ${thread.task}` }, redactedCondition = this.o.redactor.document(condition);
        const result = { ...answered, ruleContext: { ...redactedCondition, schema: 'placement-rule-context-v1', complete: JSON.stringify(condition) === JSON.stringify(redactedCondition) }, inputPacket: answered.packet, inputsRef: id, ...(jev ? { promptText: landingPromptText(jev.prompt) } : {}), ...(answered.source === 'jev' ? { rawChoice: answered.route } : {}), ...(ruled && ruled.rulesApplied.length ? { route: ruled.route, reason: ruled.reason, rulesApplied: ruled.rulesApplied } : {}),
          ...(jev ? { promptVersion: jev.version, lessons: jev.lessons.ids, ...(jev.lessons.keys?{lessonKeys:jev.lessons.keys}:{}) } : {}) };
        route = await this.#save(LandingRouteSchema.parse({ ...result, schema: 'landing-route-v1', id, projectId: project.id, threadId: thread.id, deviceId: this.o.deviceId,
          revision: 0, settingsDigest, gateValidUntil: ready.gateValidUntil, commit: ready.head, checkedCommit: ready.head, baseCommit: base, at: new Date(this.o.now()).toISOString(), questionSet: 'l-v1', state: 'waiting' }));
      }
      if (route.gateValidUntil !== ready.gateValidUntil || route.settingsDigest !== settingsDigest) route = await this.#save({ ...route, gateValidUntil: ready.gateValidUntil, settingsDigest, packet: { ...route.packet, checks: ready.checks, files: ready.files } });
      if (local.ownerLandingRequested) {
        if (route.source !== 'owner') route = await this.#save({ ...route, source: 'owner', route: 'land', state: 'waiting', reason: 'The owner chose Land now.' });
        this.o.store.updateLocal(thread.id, current => { const next = { ...current }; delete next.ownerLandingRequested; return next; });
      }
      const failures = records.filter(row => row.schema === 'verification-run-v1' && row.report?.result === 'failed').length;
      const guard = ['stopped', 'failed'].includes(priorState) ? 'The original thread has stopped or failed.' : failures >= 3 ? 'Three verification reports failed on this thread.' : route.packet.riskyAreas !== settings.riskyAreas ? 'The project’s risky areas changed after this routing decision.' : null;
      if (guard && route.source !== 'owner') route = await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: guard });
      if (route.source !== 'owner' && (!settings.autoLand || route.route === 'ask-owner')) { await this.#ask(route, thread); return { kind: 'waiting', reason: route.reason ?? 'Waiting for the owner’s landing decision.' }; }
      if (route.route === 'verify-then-land') {
        const run = await this.o.verification.reserve(thread, ready.head, failures + 1);
        if (!run) { await this.#ask(await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: 'No other provider or different model is eligible for verification.' }), thread); return { kind: 'waiting', reason: 'Waiting for the owner’s landing decision.' }; }
        route = await this.#save({ ...route, state: 'verifying', verificationId: run.id }); this.o.store.setIndexFields(thread.id, { landing: 'verifying' });
        const completed = await this.o.verification.execute(run, thread, project, thread.cwd, settings.setupCommand ?? '');
        this.o.store.setIndexFields(thread.id, { landing: undefined });
        if (!completed || completed.state !== 'passed') {
          route = await this.#save({ ...route, state: 'failed', failures: Math.min(3, failures + 1) });
          if (failures + 1 >= 3 || completed?.note) { await this.#ask(await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: completed?.note ?? 'Three verification reports failed on this thread.' }), thread); return { kind: 'waiting', reason: 'Waiting for the owner’s landing decision.' }; }
          return { kind: 'fix', reason: 'verification', failureFingerprint: failureFingerprint({ kind: 'basic-verification', failures: completed?.report?.failures ?? null }, this.o.redactor),
            body: `Basic verification failed: ${completed?.report?.failures.map(item => `${item.what}\n${item.output}`).join('\n\n') ?? 'Verification did not finish.'}`.slice(0, 20000) };
        }
      }
      let selected = route;
      return await withPublicationLease<LandingOutcome>(leases, remote, thread.id, async assertLease => {
        let checked = ready;
        for (let loop = 0; loop < 3; loop++) {
          const expired = await this.#expired(selected, checked.gateValidUntil); if (expired) return expired;
          await this.o.assertLanding(project.id, thread.id); await assertLease();
          const current = await this.o.settings(project.id);
          if ((await this.#policy(project, thread, current)).digest !== settingsDigest || current.riskyAreas !== settings.riskyAreas || selected.source !== 'owner' && !current.autoLand) { await this.#ask(await this.#save({ ...selected, source: 'guard', route: 'ask-owner', reason: 'The project settings changed before landing.' }), thread); return { kind: 'waiting', reason: 'Waiting for the owner’s landing decision.' }; }
          const latest = await this.o.git.fetchPrivate(thread.cwd, thread.baseBranch, ref, signal);
          if (latest !== base) { base = latest; const next = await this.#prepare(project, thread, current, base, signal); if (next.kind !== 'checked') return next; checked = next; }
          const path = this.o.homes.at('worktrees', project.id, 'landing', thread.id); this.o.homes.ensure('worktrees', project.id, 'landing');
          if (existsSync(path)) await this.o.git.run(thread.cwd, ['worktree', 'remove', '--force', path]);
          await this.o.git.run(thread.cwd, ['worktree', 'add', '--detach', path, base]);
          try {
            const merge = !!(await this.#delivery(thread))?.delivery.gate || checked.files.some(file => current.mergeCommitPaths.some(prefix => pathMatches(file.path, prefix)));
            const message = merge ? `Land "${thread.title}" (${thread.id})` : `${thread.title}\n\n${(thread.lastReport?.summary ?? '').split(/\n\s*\n/u)[0]!.slice(0, 500)}\n\nThread: ${thread.id}`;
            const identity = local.gitIdentity ?? await this.o.git.identity(thread.cwd), env = identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {};
            if (merge) await this.o.git.run(path, ['merge', '--no-ff', checked.head, '-m', message], { env });
            else { await this.o.git.run(path, ['merge', '--squash', checked.head]); await this.o.git.run(path, ['commit', '-m', message], { env }); }
            const landing: ThreadLanding = { commit: (await this.o.git.resolve(path, 'HEAD'))!, at: new Date(this.o.now()).toISOString(), method: merge ? 'merge-commit' : 'squash', checks: checked.checks, route: selected.route };
            const saved = await this.#save({ ...selected, state: 'landing', baseCommit: base, checkedCommit: checked.head, gateValidUntil: checked.gateValidUntil, packet: { ...selected.packet, checks: checked.checks, files: checked.files }, candidate: landing });
            selected = saved; await this.o.assertLanding(project.id, thread.id); await assertLease();
            const expired = await this.#expired(saved, checked.gateValidUntil); if (expired) return expired;
            const pushed = await this.o.git.run(path, ['push', 'origin', `HEAD:refs/heads/${thread.baseBranch}`, `--force-with-lease=refs/heads/${thread.baseBranch}:${base}`], { permitted: [1], timeoutMs: GIT_NETWORK_TIMEOUT_MS, ...(signal ? { signal } : {}) });
            if (pushed.code === 0) return { kind: 'landed', landing, routeId: saved.id };
            const moved = await this.o.git.fetchPrivate(thread.cwd, thread.baseBranch, ref, signal);
            if (moved === base) { await this.#ask(await this.#save({ ...saved, state: 'asked', source: 'guard', route: 'ask-owner', reason: failure(new Error(pushed.stderr || pushed.stdout || 'The main push was refused.'), this.o.redactor) }), thread); return { kind: 'waiting', reason: 'The main push was refused.' }; }
            if (loop === 2) { await this.#ask(await this.#save({ ...saved, source: 'guard', route: 'ask-owner', reason: 'Main moved three times during landing.' }), thread); return { kind: 'waiting', reason: 'Main moved three times during landing.' }; }
          } finally { await this.o.git.run(thread.cwd, ['worktree', 'remove', '--force', path]); }
        }
        return { kind: 'waiting', reason: 'Main moved three times during landing.' };
      });
    } catch (error) { if (signal?.aborted) throw error; if (error instanceof CheckEnvironmentBlocked) return this.waitForEnvironment(thread, failure(error, this.o.redactor)); return { kind: 'waiting', reason: (error as Error).message === PUBLICATION_BUSY ? PUBLICATION_BUSY : failure(error, this.o.redactor) }; }
  }
  async concluded(thread: Thread, routeId: string) {
    await this.#clearWait(thread, 'The checked change landed; its resource wait is resolved.');
    let route = (await this.o.hub.mergeDocument(routeId))?.document; if (route?.schema !== 'landing-route-v1') return;
    if (route.state !== 'landed') route = await this.#save({ ...route, state: 'landed' });
    if (route.decisionId) { const question = (await this.o.hub.decision(route.decisionId))?.document; if (question && !question.answer && !question.withdrawnAt) await this.o.hub.withdrawDecision(question.id, new Date(this.o.now()).toISOString(), systemWithdrawal('The checked change landed on main.')); }
    if (!thread.branch || route.backupDeletedAt) return;
    const local = this.o.store.local(thread.id), expected = local.pushedCommit;
    if (expected) {
      const deleted = await this.o.git.run(thread.cwd, ['push', 'origin', `:refs/heads/${thread.branch}`, `--force-with-lease=refs/heads/${thread.branch}:${expected}`], { permitted: [1], timeoutMs: GIT_NETWORK_TIMEOUT_MS });
      if (deleted.code !== 0 && (await this.o.git.run(thread.cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${thread.branch}`])).stdout.trim()) return;
    }
    await this.#save({ ...route, backupDeletedAt: new Date(this.o.now()).toISOString() });
  }
  async sweep() {
    for (let thread of this.o.store.all().filter(thread => thread.delivery === 'land' || thread.state === 'in-review')) {
      await this.#recoverLegacyWait(thread); thread = this.o.store.get(thread.id)!;
      const wait = this.o.store.local(thread.id).landingWait;
      if (wait && !thread.landing && thread.state === 'in-review') {
        await this.#ensureWaitQuestion(thread, wait);
        if (wait.blocker.kind === 'environment') {
          if (!await this.#environmentReady(thread)) continue;
        } else {
          if (!wait.blocker.managed && await portAcceptsConnections(wait.blocker.port)) continue;
          await this.#clearWait(thread, wait.blocker.managed ? 'Fresh managed localhost ports will be allocated for the retry.' : `The blocking port ${wait.blocker.port} is now free; landing checks resume.`);
        }
        await this.o.retry(thread.projectId, thread.id).catch(() => undefined); continue;
      }
      if (thread.delivery !== 'land') continue;
      const routes = (await this.records(thread.projectId, thread.id)).filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
      const route = thread.landing ? routes.find(row => row.candidate?.commit === thread.landing!.commit) : routes[0];
      if (!route) {
        if (thread.state !== 'in-review') continue;
        await this.o.retry(thread.projectId, thread.id).catch(() => undefined); continue;
      }
      if (!thread.landing && ['asked', 'failed', 'landed'].includes(route.state)) continue;
      if (thread.landing) await this.concluded(thread, route.id).catch(() => undefined);
      else if (thread.state === 'in-review') await this.o.retry(thread.projectId, thread.id).catch(() => undefined);
    }
  }
}
