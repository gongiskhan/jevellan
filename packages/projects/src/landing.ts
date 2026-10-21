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
  type Configuration, type DecisionAnswer, type Homes, type LandingRoute, type Project, type ProjectDecision, type ProjectHub,
  type ProjectWorkSettings, type MergeDocument, type PublicationLeaseService, type SecretRedactor, type Thread, type ThreadLanding } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import { GIT_NETWORK_TIMEOUT_MS, type ThreadGit } from './git.js';
import type { ThreadStore } from './stores.js';
import type { GitHubAccess, ThreadPublication } from './publication.js';
import type { PullRequestVerification } from './pr-verification.js';
import { outputTail, runThreadCommand, TEST_TIMEOUT_MS } from './verification.js';

export const pathMatches = (file: string, path: string): boolean => file === path.replace(/\/$/u, '') || file.startsWith(path.replace(/\/$/u, '') + '/');
export function selectedLandingChecks(settings: Pick<ProjectWorkSettings, 'landingChecks' | 'smokeCheck'>, files: readonly string[]) {
  return [...settings.landingChecks.filter(check => !check.paths.length || files.some(file => check.paths.some(path => pathMatches(file, path)))),
    ...(settings.smokeCheck ? [{ name: 'Smoke check', paths: [], command: settings.smokeCheck }] : [])];
}
export type LandingOutcome = { kind: 'landed'; landing: ThreadLanding; routeId: string } | { kind: 'no-changes' }
  | { kind: 'fix'; reason: 'conflict' | 'verification'; body: string; tail?: string } | { kind: 'waiting'; reason: string };
/** The port a failed check could not bind because another process held it, from the check's output. */
export function heldPort(output: string): number | null {
  const match = /EADDRINUSE[^\n]*?:(\d{2,5})\b/u.exec(output) ?? /\bport\s+(\d{2,5})\b[^\n]{0,80}?\b(?:already in use|in use|is held|held by|busy)/iu.exec(output);
  const port = match ? Number(match[1]) : NaN; return port > 0 && port < 65536 ? port : null;
}
/**
 * Who listens on a TCP port of this device: null when nothing accepts a connection there; else the process lsof or ss names, when either
 * is installed and can see it.
 */
export async function portHolder(port: number): Promise<{ pid?: number; command?: string } | null> {
  const open = await new Promise<boolean>(resolve => {
    const socket = connect({ port, host: '127.0.0.1', timeout: 2000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('timeout', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(false));
  });
  if (!open) return null;
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
export type LandingJev = { version: number; prompt: LandingPrompt; lessons: { ids: string[]; texts: string[] };
  apply(route: 'land' | 'verify-then-land' | 'ask-owner', thread: Thread): { route: 'land' | 'verify-then-land' | 'ask-owner'; rulesApplied: string[]; reason: string } };
export class ThreadLandingService {
  /** Threads whose landing waits for a port another process holds: the sweep retries them once it is free. */
  readonly #ports = new Map<string, number>();
  constructor(readonly o: { homes: Homes; git: ThreadGit; github: GitHubAccess; publication: ThreadPublication; hub: ProjectHub; store: ThreadStore;
    verification: PullRequestVerification; leases?: PublicationLeaseService; deviceId: string; redactor: SecretRedactor; now(): number;
    settings(projectId: string): Promise<ProjectWorkSettings>; configuration(): Promise<Configuration['x-jevellan']>; decisionClient?: DecisionSource;
    projectEnvironment?(projectId: string): Promise<Record<string, string>>; assertLanding(projectId: string, threadId: string): Promise<void>;
    retry(projectId: string, threadId: string): Promise<void>;
    /** Jev control (bridge): the active l-v1 prompt, the lessons Jev reads, and the owner's rules applied after its answer. */
    jev?(projectId: string): Promise<LandingJev | undefined> }) {}
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
    if (route.decisionId) { const item = (await this.o.hub.decision(route.decisionId))?.document; if (item && !item.answer && !item.withdrawnAt) await this.o.hub.withdrawDecision(item.id, new Date(this.o.now()).toISOString()); }
    await this.#save({ ...route, source: 'owner', route: choice, state: 'waiting', reason: `The owner chose ${choice}.` });
    if (this.o.store.get(threadId)) await this.o.retry(projectId, threadId);
    return true;
  }
  async override(thread: Thread) {
    const rows = (await this.records(thread.projectId, thread.id)).filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
    const route = rows[0]; if (route) {
      if (route.decisionId) { const item = (await this.o.hub.decision(route.decisionId))?.document; if (item && !item.answer) await this.o.hub.withdrawDecision(item.id, new Date(this.o.now()).toISOString()); }
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
  async #gate(thread: Thread, base: string, head: string, files: string[], signal?: AbortSignal) {
    const bound = await this.#delivery(thread); if (!bound?.delivery.gate) return null;
    const { run, delivery } = bound, gate = delivery.gate!;
    if (run.deviceId !== this.o.deviceId) throw new Error('This landing needs the device holding its private job input.');
    if (files.some(file => gate.protectedPaths.some(path => pathMatches(file, path)))) throw new Error('The candidate changed a protected evaluation path.');
    const directory = deliveryDirectory(this.o.homes, thread.projectId, run.id), inputFile = join(directory, `${delivery.id}.json`), input = readDocument(inputFile, PrivateJobDeliverySchema);
    if (input.sha256 !== delivery.inputSha256 || input.trustedCommit !== run.commit || input.runId !== run.id || input.deliveryId !== delivery.id) throw new Error('The private gate input does not match its job receipt.');
    const workspace = this.o.homes.ensure('project-work', thread.projectId, 'job-cache', 'gates', thread.id, head), trusted = join(workspace, 'trusted');
    if (!existsSync(trusted)) await this.o.git.run(thread.cwd, ['worktree', 'add', '--detach', trusted, run.commit]);
    if (await this.o.git.resolve(trusted, 'HEAD') !== run.commit || (await this.o.git.run(trusted, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) throw new Error('The trusted gate checkout changed.');
    const resultFile = join(workspace, 'project-job-gate-result.json'), gateInput = join(workspace, 'private-input.json');
    writeDocument(gateInput, PrivateJobDeliverySchema, input);
    const result = await runThreadCommand(trusted, gate.command, { homes: this.o.homes, workId: thread.id, redactor: this.o.redactor, environmentScope: 'command', timeoutMs: gate.timeoutMinutes * 60000, ...(signal ? { signal } : {}), projectEnv: await this.o.projectEnvironment?.(thread.projectId) ?? {}, gitEnv: { JEVELLAN_GATE_INPUT: gateInput, JEVELLAN_GATE_CANDIDATE: thread.cwd, JEVELLAN_GATE_CANDIDATE_COMMIT: head, JEVELLAN_GATE_BASE_COMMIT: base, JEVELLAN_GATE_RESULT: resultFile }, jobContext: { schema: 'project-job-context-v1', projectId: run.projectId, runId: run.id, jobId: run.jobId, workspace, commandCheckout: trusted, commit: run.commit } });
    if (result.code !== 0 || result.timedOut || !existsSync(resultFile)) throw new Error(`The trusted job gate did not pass: ${outputTail(result, 2000)}`);
    const receipt = readDocument(resultFile, JobGateResultSchema);
    if (!receipt.passed || receipt.checks.some(row => !row.passed) || receipt.trustedCommit !== run.commit || receipt.candidateCommit !== head || await this.o.git.resolve(thread.cwd, 'HEAD') !== head) throw new Error('The trusted job gate refused this candidate.');
    if (receipt.validUntil && Date.parse(receipt.validUntil) <= this.o.now()) throw new Error('The required job gate deadline expired. This work needs a fresh measured delivery.');
    return { check: { name: gate.id, passed: true, at: new Date(this.o.now()).toISOString() }, validUntil: receipt.validUntil };
  }
  async #expired(route: LandingRoute, validUntil: string | undefined): Promise<LandingOutcome | null> {
    if (!validUntil || Date.parse(validUntil) > this.o.now()) return null;
    const reason = 'The required job gate deadline expired. This work needs a fresh measured delivery.';
    await this.#save({ ...route, state: 'failed', reason });
    return { kind: 'waiting', reason };
  }
  async #prepare(thread: Thread, settings: ProjectWorkSettings, base: string, signal?: AbortSignal) {
    const rebase = await this.o.git.run(thread.cwd, ['rebase', base], { permitted: [1], ...(signal ? { signal } : {}) });
    if (rebase.code !== 0) {
      const files = (await this.o.git.run(thread.cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean);
      await this.o.git.run(thread.cwd, ['rebase', '--abort']);
      return { kind: 'fix' as const, reason: 'conflict' as const, body: `Landing stopped: main moved and these files conflict: ${files.join(', ')}. Run git fetch origin and git rebase origin/${thread.baseBranch} in your worktree, resolve the conflicts keeping the intent of both sides, run the relevant tests and report done.` };
    }
    const files = await this.#files(thread, base), checks: ThreadLanding['checks'] = [];
    for (const check of selectedLandingChecks(settings, files.map(file => file.path))) {
      const head = await this.o.git.resolve(thread.cwd, 'HEAD');
      const result = await runThreadCommand(thread.cwd, check.command, { homes: this.o.homes, workId: thread.id, environmentScope: 'command', timeoutMs: TEST_TIMEOUT_MS, redactor: this.o.redactor,
        projectEnv: await this.o.projectEnvironment?.(thread.projectId) ?? {}, ...(signal ? { signal } : {}) });
      const passed = result.code === 0 && !result.timedOut && await this.o.git.resolve(thread.cwd, 'HEAD') === head
        && !(await this.o.git.run(thread.cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
      checks.push({ name: check.name, passed, at: new Date(this.o.now()).toISOString() });
      // A port another process holds is the device's state, not the thread's change: landing waits for it instead of asking for a fix.
      const port = passed || result.timedOut ? null : heldPort(outputTail(result, 8000)); const holder = port === null ? null : await portHolder(port);
      if (port !== null && holder) { this.#ports.set(thread.id, port); return { kind: 'waiting' as const, reason: this.o.redactor.text(`${check.name} could not start: port ${port} is in use by ${holderText(holder)}. It lands by itself once the port is free.`) }; }
      if (!passed) { const tail = this.o.redactor.text(outputTail(result, 4000) || 'The check changed the worktree or its commit.'); return { kind: 'fix' as const, reason: 'verification' as const, tail,
        body: `Landing checks failed (attempt ${thread.verificationAttempts + 1} of 3). ${check.name}: ${tail}. Fix the cause, run the relevant tests and report done.` }; }
    }
    const head = (await this.o.git.resolve(thread.cwd, 'HEAD'))!;
    const gate = await this.#gate(thread, base, head, files.map(file => file.path), signal); if (gate) checks.push(gate.check);
    return { kind: 'checked' as const, files, checks, head, gateValidUntil: gate?.validUntil };
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
        if (copied.length) return { kind: 'fix', reason: 'verification', body: `Landing checks failed (attempt ${thread.verificationAttempts + 1} of 3). Copied files: remove ${copied.join(', ')} from this branch's commits. Fix the cause, run the relevant tests and report done.` };
      }
      await this.o.publication.backupWorktree(thread, signal);
      const remote = await this.o.git.remoteUrl(thread.cwd); if (!remote) return { kind: 'waiting', reason: 'Landing needs a git remote.' };
      const ref = `refs/jevellan/threads/${thread.id}/landing-base`;
      let base = await this.o.git.fetchPrivate(thread.cwd, thread.baseBranch, ref, signal);
      const records = await this.records(project.id, thread.id), currentHead = await this.o.git.resolve(thread.cwd, 'HEAD');
      // A pushed candidate is durable before its transport acknowledgement. Recover it even if another landing followed.
      for (const old of records) if (old.schema === 'landing-route-v1' && old.checkedCommit === currentHead && old.candidate && (await this.o.git.run(thread.cwd, ['merge-base', '--is-ancestor', old.candidate.commit, base], { permitted: [1] })).code === 0) return { kind: 'landed', landing: old.candidate, routeId: old.id };
      if (!(await this.o.git.run(thread.cwd, ['diff', '--name-only', `${base}...HEAD`])).stdout) return { kind: 'no-changes' };
      const settings = await this.o.settings(project.id), digest = (value: ProjectWorkSettings) => createHash('sha256').update(stableJson({ checks: value.landingChecks, smoke: value.smokeCheck, merge: value.mergeCommitPaths, environment: value.environment })).digest('hex');
      const settingsDigest = digest(settings), head = await this.o.git.resolve(thread.cwd, 'HEAD');
      const gated = !!(await this.#delivery(thread))?.delivery.gate;
      const cached = records.find((row): row is LandingRoute => row.schema === 'landing-route-v1' && row.checkedCommit === head && row.baseCommit === base && row.settingsDigest === settingsDigest && row.packet.checks.every(check => check.passed) && (!gated || !!row.gateValidUntil && Date.parse(row.gateValidUntil) > this.o.now()));
      const ready = cached ? { kind: 'checked' as const, files: cached.packet.files, checks: cached.packet.checks, head: cached.checkedCommit!, gateValidUntil: cached.gateValidUntil } : await this.#prepare(thread, settings, base, signal); if (ready.kind !== 'checked') return ready;
      const id = derivedId('lroute', thread.id, ready.head); let route = (await this.o.hub.mergeDocument(id))?.document;
      if (route && route.schema !== 'landing-route-v1') throw new Error('This landing receipt has another schema.');
      if (!route) {
        for (const old of records) if (old.schema === 'landing-route-v1' && old.commit !== ready.head && old.decisionId) { const item = (await this.o.hub.decision(old.decisionId))?.document; if (item && !item.answer && !item.withdrawnAt) await this.o.hub.withdrawDecision(item.id, new Date(this.o.now()).toISOString()); }
        const corrections = (await this.records(project.id)).filter(row => row.schema === 'merge-correction-v1' || row.schema === 'landing-correction-v1')
          .sort((a, b) => b.at.localeCompare(a.at) || (('receivedOrder' in b ? b.receivedOrder : 0) ?? 0) - (('receivedOrder' in a ? a.receivedOrder : 0) ?? 0)).slice(0, 8)
          .map(row => 'correction' in row ? `For “${row.title}”, the owner said: ${row.correction === 'should-have-asked' ? 'Should have asked me' : "Didn't need asking"}.` : '');
        const packet = { schema: 'landing-route-state-v1' as const, title: thread.title, task: thread.taskContext ?? { type: 'feature' as const, needs: [], goal: null }, summary: (thread.lastReport?.summary ?? '').slice(0, 4000), files: ready.files, checks: ready.checks, riskyAreas: settings.riskyAreas, corrections };
        const jev = await this.o.jev?.(project.id).catch(() => undefined);
        const asked = jev?.lessons ? { ...packet, corrections: jev.lessons.texts.slice(0, 8) } : packet;
        const answered = await decideLandingRoute(this.o.decisionClient, asked, async () => (await this.o.configuration()).decisions.model, this.o.redactor, signal ?? new AbortController().signal, jev?.prompt);
        const ruled = answered.source === 'jev' && jev ? jev.apply(answered.route, thread) : undefined;
        const result = { ...answered, ...(answered.source === 'jev' ? { rawChoice: answered.route } : {}), ...(ruled && ruled.rulesApplied.length ? { route: ruled.route, reason: ruled.reason, rulesApplied: ruled.rulesApplied } : {}),
          ...(jev ? { promptVersion: jev.version, lessons: jev.lessons.ids.slice(0, 8) } : {}) };
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
          return { kind: 'fix', reason: 'verification', body: `Basic verification failed: ${completed?.report?.failures.map(item => `${item.what}\n${item.output}`).join('\n\n') ?? 'Verification did not finish.'}`.slice(0, 20000) };
        }
      }
      let selected = route;
      return await withPublicationLease<LandingOutcome>(leases, remote, thread.id, async assertLease => {
        let checked = ready;
        for (let loop = 0; loop < 3; loop++) {
          const expired = await this.#expired(selected, checked.gateValidUntil); if (expired) return expired;
          await this.o.assertLanding(project.id, thread.id); await assertLease();
          const current = await this.o.settings(project.id);
          if (digest(current) !== settingsDigest || current.riskyAreas !== settings.riskyAreas || selected.source !== 'owner' && !current.autoLand) { await this.#ask(await this.#save({ ...selected, source: 'guard', route: 'ask-owner', reason: 'The project settings changed before landing.' }), thread); return { kind: 'waiting', reason: 'Waiting for the owner’s landing decision.' }; }
          const latest = await this.o.git.fetchPrivate(thread.cwd, thread.baseBranch, ref, signal);
          if (latest !== base) { base = latest; const next = await this.#prepare(thread, current, base, signal); if (next.kind !== 'checked') return next; checked = next; }
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
    } catch (error) { if (signal?.aborted) throw error; return { kind: 'waiting', reason: (error as Error).message === PUBLICATION_BUSY ? PUBLICATION_BUSY : failure(error, this.o.redactor) }; }
  }
  async concluded(thread: Thread, routeId: string) {
    let route = (await this.o.hub.mergeDocument(routeId))?.document; if (route?.schema !== 'landing-route-v1') return;
    if (route.state !== 'landed') route = await this.#save({ ...route, state: 'landed' });
    if (route.decisionId) { const question = (await this.o.hub.decision(route.decisionId))?.document; if (question && !question.answer && !question.withdrawnAt) await this.o.hub.withdrawDecision(question.id, new Date(this.o.now()).toISOString()); }
    if (!thread.branch || route.backupDeletedAt) return;
    const local = this.o.store.local(thread.id), expected = local.pushedCommit;
    if (expected) {
      const deleted = await this.o.git.run(thread.cwd, ['push', 'origin', `:refs/heads/${thread.branch}`, `--force-with-lease=refs/heads/${thread.branch}:${expected}`], { permitted: [1], timeoutMs: GIT_NETWORK_TIMEOUT_MS });
      if (deleted.code !== 0 && (await this.o.git.run(thread.cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${thread.branch}`])).stdout.trim()) return;
    }
    await this.#save({ ...route, backupDeletedAt: new Date(this.o.now()).toISOString() });
  }
  async sweep() {
    for (const thread of this.o.store.all().filter(thread => thread.delivery === 'land')) {
      const routes = (await this.records(thread.projectId, thread.id)).filter((row): row is LandingRoute => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at));
      const route = thread.landing ? routes.find(row => row.candidate?.commit === thread.landing!.commit) : routes[0];
      if (!route) {
        if (thread.state !== 'in-review') continue;
        const port = this.#ports.get(thread.id); if (port !== undefined && await portHolder(port)) continue;
        this.#ports.delete(thread.id); await this.o.retry(thread.projectId, thread.id).catch(() => undefined); continue;
      }
      if (!thread.landing && ['asked', 'failed', 'landed'].includes(route.state)) continue;
      if (thread.landing) await this.concluded(thread, route.id).catch(() => undefined);
      else if (thread.state === 'in-review') await this.o.retry(thread.projectId, thread.id).catch(() => undefined);
    }
  }
}
