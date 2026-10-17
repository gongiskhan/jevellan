import { decideMergeRoute, type DecisionClient } from '@jevellan/decisions';
import { MergeCorrectionInputSchema, MergeCorrectionSchema, MergeDocumentsViewSchema, MergeRouteSchema, ProjectDecisionSchema, parseGitHubPullUrl,
  type Configuration, type CoordinatorEvent, type DecisionAnswer, type MergeDocument, type MergeRoute, type Project, type ProjectDecision, type ProjectHub, type ProjectWorkSettings, type SecretRedactor, type Thread } from '@jevellan/core';
import type { ThreadStore } from './stores.js';
import type { PullRequestTracker } from './pull-requests.js';
import type { GitHubAccess } from './publication.js';
import type { PullRequestVerification } from './pr-verification.js';
import { derivedId } from './decision-items.js';
const refuse = (message: string, status = 409) => Object.assign(new Error(message), { status });
const turnBusy = (thread: Thread) => ['running', 'preparing', 'publishing', 'attached'].includes(thread.state);
const green = (thread: Thread) => !turnBusy(thread) && thread.pr?.state === 'open' && ['passing', 'none'].includes(thread.pr.checks) && thread.pr.mergeable === 'clean';

/** The thread's owner advances the gate. Hub CAS receipts and checked GitHub SHAs fence retries and moved heads. */
export class ProjectMergeGate {
  readonly #active = new Map<string, Promise<void>>();
  readonly #concluded = new Set<string>();
  readonly #abort = new AbortController();
  #closed = false;
  constructor(readonly o: { hub: ProjectHub; store: Pick<ThreadStore, 'all' | 'get'> & Partial<Pick<ThreadStore, 'setIndexFields' | 'local'>>; tracker: PullRequestTracker; github: GitHubAccess; verification: PullRequestVerification; deviceId: string; redactor: SecretRedactor; now(): number;
    settings(projectId: string): Promise<ProjectWorkSettings>; configuration(): Promise<Configuration['x-jevellan']>; decisionClient?(): Promise<DecisionClient>;
    project(projectId: string): Promise<Project>; repository(project: Project): string; event(projectId: string, event: CoordinatorEvent): Promise<void>;
    message(projectId: string, threadId: string, text: string, messageId: string): Promise<unknown>; assertMerge(projectId: string, threadId: string): Promise<void> }) {}
  busy() { return this.#active.size > 0 || this.o.verification.busy(); }
  async documents(projectId: string, threadId?: string): Promise<MergeDocument[]> {
    const records: MergeDocument[] = []; let after: string | undefined;
    do { const page = await this.o.hub.mergeDocuments(projectId, after, threadId); records.push(...page.records); after = page.next ?? undefined; } while (after);
    return records;
  }
  async view(projectId: string, threadId: string) { return MergeDocumentsViewSchema.parse({ schema: 'merge-documents-view-v1', records: await this.documents(projectId, threadId) }); }
  async correct(projectId: string, threadId: string, raw: unknown) {
    const input = MergeCorrectionInputSchema.parse(raw), thread = (await this.o.hub.thread(threadId))?.document;
    if (!thread || thread.projectId !== projectId) throw refuse('Thread not found.', 404);
    if (!(await this.documents(projectId, threadId)).some(row => row.schema === 'merge-route-v1' && row.threadId === threadId && row.commit === input.commit)) throw refuse('This pull request has no merge route at that commit.');
    await this.o.hub.putMergeDocument(MergeCorrectionSchema.parse({ schema: 'merge-correction-v1', id: derivedId('mcor', projectId, threadId, input.clientRequestId), projectId, threadId, revision: 0,
      deviceId: this.o.deviceId, commit: input.commit, title: thread.title, correction: input.correction, at: new Date(this.o.now()).toISOString() }), 0);
    return this.view(projectId, threadId);
  }
  sweep(): void {
    if (this.#closed) return;
    for (const thread of this.o.store.all()) {
      if (!thread.pr || thread.ownerDeviceId !== this.o.deviceId || turnBusy(thread) || this.#active.has(thread.id) || this.#concluded.has(thread.id)) continue;
      const promise = this.#advance(thread.id).catch(() => undefined).finally(() => this.#active.delete(thread.id)); this.#active.set(thread.id, promise);
    }
  }
  async #save(route: MergeRoute) { if (route.state === 'merged' && !route.mergedAt) route = { ...route, mergedAt: new Date(this.o.now()).toISOString() }; return MergeRouteSchema.parse((await this.o.hub.putMergeDocument(MergeRouteSchema.parse(this.o.redactor.document(route)), route.revision)).document); }
  async #event(route: MergeRoute, outcome: Extract<CoordinatorEvent, { kind: 'merge-gate' }>['outcome'], summary: string) {
    const key = `${outcome}:${route.verificationId ?? route.failures}`;
    if (route.notified.includes(key)) return route;
    await this.o.event(route.projectId, { schema: 'coordinator-event-v1', kind: 'merge-gate', id: derivedId('cev', route.id, outcome, route.verificationId ?? String(route.failures)), at: new Date(this.o.now()).toISOString(), threadId: route.threadId, prNumber: route.prNumber, commit: route.commit, outcome, summary: this.o.redactor.text(summary).slice(0, 2000) });
    return this.#save({ ...route, notified: [...route.notified, key] });
  }
  async #ask(route: MergeRoute, thread: Thread) {
    const id = route.decisionId ?? derivedId('pdec', 'merge', route.id);
    if (!(await this.o.hub.decision(id))) await this.o.hub.createDecision(ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: 0, id, projectId: route.projectId, threadId: thread.id, from: 'thread',
      question: `Merge #${route.prNumber} ${thread.title}?`, options: [{ label: 'Merge' }, { label: 'Send back with a note' }, { label: 'Close' }], createdAt: route.at, merge: { commit: route.commit, prNumber: route.prNumber, ...(route.reason ? { reason: route.reason } : {}), ...(route.verificationId ? { failures: ((await this.o.hub.mergeDocument(route.verificationId))?.document as { report?: { failures: Array<{ what: string; output: string }> } })?.report?.failures ?? [] } : {}) } }));
    if (route.state !== 'asked' || !route.decisionId) route = await this.#save({ ...route, route: 'ask-owner', state: 'asked', decisionId: id });
    route = await this.#event(route, 'ask-owner', route.reason ?? 'This pull request needs the owner’s decision.');
    const decision = (await this.o.hub.decision(id))?.document;
    if (decision?.answer) await this.answer(decision, decision.answer, false);
  }
  #ready(thread: Thread, settings: ProjectWorkSettings) {
    if (!green(thread) || thread.queuedMessages.some(message => message.from === 'coordinator')) return false;
    if (settings.requiredChecks.length) return settings.requiredChecks.every(name => thread.pr!.passedChecks?.includes(name));
    return thread.pr!.checks !== 'none' || this.o.now() - Date.parse(thread.pr!.headFirstSeenAt ?? thread.pr!.updatedAt) >= 5 * 60_000;
  }
  async #deliverFailure(route: MergeRoute, run: Extract<MergeDocument, { schema: 'verification-run-v1' }>, thread: Thread) {
    if (route.failureDeliveredAt) return;
    try {
      if (['stopped', 'failed', 'done'].includes(thread.state)) throw new Error('The original thread has ended and cannot receive the verification failures.');
      await this.o.message(route.projectId, thread.id, `Basic verification failed for #${route.prNumber} at ${route.commit}.\n\n${run.report?.failures.map(failure => `${failure.what}\n${failure.output}`).join('\n\n') ?? ''}`.slice(0, 20000), derivedId('tmsg', 'verification', run.id));
      await this.#save({ ...route, failureDeliveredAt: new Date(this.o.now()).toISOString() });
    } catch (error) { await this.#ask(await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: this.o.redactor.text(error instanceof Error ? error.message : 'The thread cannot receive the failures.').slice(0, 1200) }), thread); }
  }
  #landing(threadId: string, value: 'verifying' | 'merging' | undefined, expected?: 'verifying' | 'merging'): void {
    if (expected && this.o.store.local?.(threadId).landing !== expected) return;
    this.o.store.setIndexFields?.(threadId, { landing: value });
  }
  async #advance(threadId: string) {
    const thread = this.o.store.get(threadId); if (!thread?.pr) return;
    const records = await this.documents(thread.projectId, threadId);
    if (thread.pr.state !== 'open') {
      for (const row of records) if (row.schema === 'merge-route-v1' && row.decisionId) {
        const item = (await this.o.hub.decision(row.decisionId))?.document;
        if (item && !item.answer && !item.withdrawnAt) await this.o.hub.withdrawDecision(item.id, new Date(this.o.now()).toISOString());
        if (row.commit === thread.pr.headSha && row.state !== 'merged') await this.#save({ ...row, state: thread.pr.state === 'merged' ? 'merged' : 'failed' });
      }
      const current = records.find(row => row.schema === 'merge-route-v1' && row.commit === thread!.pr!.headSha);
      if (current?.schema === 'merge-route-v1' && !current.decisionId && current.state !== 'merged') await this.#save({ ...current, state: thread.pr.state === 'merged' ? 'merged' : 'failed' });
      this.#concluded.add(threadId); return;
    }
    const settings = await this.o.settings(thread.projectId);
    if (settings.status !== 'active' || !this.#ready(thread, settings)) return;
    const commit = thread.pr.headSha, id = derivedId('mroute', threadId, commit);
    for (const row of records) if (row.schema === 'merge-route-v1' && row.commit !== commit && row.decisionId) {
      const old = (await this.o.hub.decision(row.decisionId))?.document; if (old && !old.answer && !old.withdrawnAt) await this.o.hub.withdrawDecision(old.id, new Date(this.o.now()).toISOString());
    }
    let route = (await this.o.hub.mergeDocument(id))?.document;
    if (route && route.schema !== 'merge-route-v1') throw refuse('Invalid merge route receipt.');
    if (route?.state === 'failed') {
      const run = route.verificationId ? (await this.o.hub.mergeDocument(route.verificationId))?.document : null;
      if (settings.autoMerge && run?.schema === 'verification-run-v1' && run.report?.result === 'failed' && !run.note) await this.#deliverFailure(route, run, thread);
      return;
    }
    if (!route) {
      const diff = await this.o.tracker.diff(thread.projectId, threadId, true); if (diff.commit !== commit) return;
      const corrections = (await this.documents(thread.projectId)).filter(row => row.schema === 'merge-correction-v1').sort((a, b) => b.at.localeCompare(a.at) || (b.receivedOrder ?? 0) - (a.receivedOrder ?? 0) || b.id.localeCompare(a.id)).slice(0, 8)
        .map(row => row.schema === 'merge-correction-v1' ? `For “${row.title}”, the owner said: ${row.correction === 'should-have-asked' ? 'Should have asked me' : "Didn't need asking"}.` : '');
      const packet = { schema: 'merge-route-state-v1' as const, title: thread.title.slice(0, 120), task: thread.taskContext ?? { type: 'feature' as const, needs: [], goal: null }, summary: (thread.lastReport?.summary ?? '').slice(0, 4000), riskyAreas: settings.riskyAreas,
        files: diff.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })), totalSize: diff.files.reduce((sum, file) => sum + file.additions + file.deletions, 0), corrections };
      const moved = records.filter((row): row is MergeRoute => row.schema === 'merge-route-v1' && row.headMoved === true);
      const failures = Math.min(3, records.filter(row => row.schema === 'verification-run-v1' && row.state === 'failed' && row.report?.result === 'failed' && !row.note).length);
      let client: DecisionClient | undefined; try { client = await this.o.decisionClient?.(); } catch { /* The documented fallback is ask-owner. */ }
      const config = await this.o.configuration(), result = await decideMergeRoute(client, packet, config.decisions.model, this.o.redactor, AbortSignal.any([this.#abort.signal, AbortSignal.timeout(config.decisions.timeoutMs)]));
      if (this.#closed) return;
      route = await this.#save(MergeRouteSchema.parse({ ...result, schema: 'merge-route-v1', id, projectId: thread.projectId, threadId, deviceId: this.o.deviceId, revision: 0, commit, at: new Date(this.o.now()).toISOString(), prNumber: thread.pr.number,
        questionSet: 'm-v1', state: 'waiting', failures, verificationRetries: moved.length ? 1 : 0, decisionId: null, verificationId: null,
        ...(moved.some(row => row.verificationRetries >= 1) ? { route: 'ask-owner', source: 'guard', reason: 'The pull request head moved during verification again after one retry.' } : {}),
        ...(failures >= 3 ? { route: 'ask-owner', source: 'guard', reason: 'Three verification reports failed on this pull request.' } : {}) }));
    }
    let handoff = false, after: string | undefined;
    do { const page = await this.o.hub.jobs(thread.projectId, after); handoff ||= page.records.some(job => job.run.kind === 'github-workflow' && (job.run.dispatchAfterMerge?.pull === thread!.pr!.number || job.run.schedulerSwitch?.ownerMergePull === thread!.pr!.number)); after = page.next ?? undefined; } while (after);
    const reason = handoff ? 'The workflow handoff always needs the owner’s merge decision.' : ['stopped', 'failed'].includes(thread.state) ? 'The original thread has stopped or failed.' : route.packet.riskyAreas !== settings.riskyAreas ? 'The project’s risky areas changed after this routing decision.' : null;
    if (reason && (route.route !== 'ask-owner' || route.reason !== reason)) route = await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason });
    // Shadow routes explain Jev's choice without performing the route's actions.
    if (!settings.autoMerge) return;
    if (route.route === 'ask-owner') { await this.#ask(route, thread); return; }
    if (route.route === 'test-then-merge') {
      let run = route.verificationId ? (await this.o.hub.mergeDocument(route.verificationId))?.document : null;
      if (!run || run.schema !== 'verification-run-v1') run = await this.o.verification.reserve(thread, commit, route.failures * 2 + route.verificationRetries + 1);
      if (!run || run.schema !== 'verification-run-v1') { await this.#ask(await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: 'No other provider or different model is eligible for verification.' }), thread); return; }
      if (route.verificationId !== run.id || route.state === 'waiting') route = await this.#save({ ...route, state: 'verifying', verificationId: run.id });
      const project = await this.o.project(thread.projectId);
      this.#landing(threadId, 'verifying');
      let completed: Awaited<ReturnType<PullRequestVerification['execute']>>;
      try { completed = await this.o.verification.execute(run, thread, project, this.o.repository(project), settings.setupCommand ?? ''); }
      finally { this.#landing(threadId, undefined, 'verifying'); }
      if (!completed) return;
      if (completed.state === 'failed') {
        if (completed.note || completed.report?.result !== 'failed') {
          const reason = completed.note ?? 'Verification ended without a failed test report.';
          route = await this.#event(route, 'verification-failed', reason);
          if (completed.headMoved) { await this.#save({ ...route, state: 'failed', headMoved: true, reason }); return; }
          if (!route.verificationRetries) { await this.#save({ ...route, verificationRetries: 1, verificationId: null, state: 'waiting', reason }); return; }
          await this.#ask(await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: `Verification could not complete after one retry: ${reason}`.slice(0, 1200) }), thread); return;
        }
        route = await this.#save({ ...route, failures: Math.min(3, route.failures + 1), state: 'failed' });
        route = await this.#event(route, 'verification-failed', completed.report.failures.map(failure => failure.what).join('; ') || 'Verification failed.');
        if (route.failures >= 3) { await this.#ask(await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: 'Three verification reports failed on this pull request.' }), thread); return; }
        await this.#deliverFailure(route, completed, this.o.store.get(threadId) ?? thread); return;
      }
      route = await this.#event(route, 'verification-passed', `${completed.modelLabel} (${completed.providerChoice}) passed basic verification.`);
    }
    const latest = this.o.store.get(threadId), currentSettings = await this.o.settings(route.projectId);
    if (this.#closed || !currentSettings.autoMerge || !latest || !this.#ready(latest, currentSettings) || ['stopped', 'failed'].includes(latest.state) || latest.pr!.headSha !== route.commit) return;
    if (route.packet.riskyAreas !== currentSettings.riskyAreas) {
      await this.#ask(await this.#save({ ...route, route: 'ask-owner', source: 'guard', reason: 'The project’s risky areas changed after this routing decision.' }), latest);
      return;
    }
    await this.o.assertMerge(route.projectId, threadId);
    if (route.state !== 'merging') route = await this.#save({ ...route, state: 'merging' });
    this.#landing(threadId, 'merging');
    try { await this.o.tracker.merge(threadId, route.commit); }
    catch (error) {
      if (error instanceof Error && 'headMoved' in error && error.headMoved === true && route.verificationId) {
        const run = (await this.o.hub.mergeDocument(route.verificationId))?.document;
        if (run?.schema === 'verification-run-v1') await this.o.hub.putMergeDocument({ ...run, state: 'failed', headMoved: true, note: 'The pull request head changed before the checked merge.' }, run.revision);
        route = await this.#save({ ...route, state: 'failed', headMoved: true, reason: 'The pull request head changed before the checked merge.' });
        await this.#event(route, 'verification-failed', route.reason!);
      }
      throw error;
    } finally { this.#landing(threadId, undefined, 'merging'); }
    route = await this.#save({ ...route, state: 'merged' });
    await this.#event(route, 'automatically-merged', `Squash-merged checked commit ${route.commit}.`);
  }
  /** Owner decision effects are separate from the coordinator tool scope and are safe to retry. */
  async answer(decision: ProjectDecision, answer: DecisionAnswer, validateOnly: boolean) {
    if (!decision.merge || !decision.threadId) return false;
    const thread = this.o.store.get(decision.threadId); if (!thread || thread.projectId !== decision.projectId) throw refuse('This merge item belongs on the thread’s device.');
    const id = derivedId('mroute', thread.id, decision.merge.commit), row = (await this.o.hub.mergeDocument(id))?.document;
    if (row?.schema !== 'merge-route-v1' || row.decisionId !== decision.id) throw refuse('The merge item has no matching route.');
    if (row.state === 'merged' || row.state === 'failed') return true;
    const read = await this.o.tracker.fresh(decision.projectId, thread.id), current = read.pr;
    if (read.reason) throw refuse(read.reason);
    if (answer.optionLabel === 'Merge' && current?.state === 'merged') { if (!validateOnly) await this.#save({ ...row, state: 'merged' }); return true; }
    if (answer.optionLabel === 'Close' && current?.state === 'closed') { if (!validateOnly) await this.#save({ ...row, state: 'failed' }); return true; }
    if (!current || current.state !== 'open' || current.headSha !== decision.merge.commit) throw refuse('The pull request head changed. Wait for its new merge decision.');
    if (answer.optionLabel === 'Merge') await this.o.assertMerge(decision.projectId, thread.id);
    if (answer.optionLabel === 'Send back with a note' && !answer.text?.trim()) throw refuse('Write a note to send this pull request back.', 400);
    if (!['Merge', 'Send back with a note', 'Close'].includes(answer.optionLabel ?? '')) throw refuse('Choose a merge action.', 400);
    if (validateOnly) return true;
    if (answer.optionLabel === 'Merge') { await this.o.tracker.merge(thread.id, decision.merge.commit); await this.#save({ ...row, state: 'merged' }); }
    else if (answer.optionLabel === 'Close') { const repository = parseGitHubPullUrl(current.url); if (!repository) throw refuse('Not a GitHub pull request.'); await (await this.o.github.open(decision.projectId)).closePull(repository, current.number); await this.o.tracker.refresh(thread.id); await this.#save({ ...row, state: 'failed' }); }
    else { await this.o.message(decision.projectId, thread.id, answer.text!, derivedId('tmsg', 'merge-owner', decision.id)); await this.#save({ ...row, state: 'failed' }); }
    return true;
  }
  async close() { this.#closed = true; this.#abort.abort(); await this.o.verification.close(); await Promise.allSettled([...this.#active.values()]); }
}
