import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemorySessionSchema, MemoryDreamRequestSchema, IdSchema, atomicWrite, newId, readDocument, writeDocument, type CoordinatorEvent, type MemorySession,
  type Project, type ProjectHub, type SecretRedactor } from '@jevellan/core';
import { MemoryDream, collectMemoryCandidates, readMemoryFiles, type HubMemoryStore, type ProjectCaptureQueue } from '@jevellan/memory';
import type { TurnLauncher } from './launch.js';
import type { ThreadGit } from './git.js';
import type { Placement } from './placement.js';
import type { ProjectDailyWork } from './daily.js';
import { MemorySessionTools } from './memory-tools.js';
import { TurnExecution } from './turn-execution.js';
import { endTurnProcess } from './recovery.js';
import { derivedId } from './decision-items.js';

export const extractionAppend = (project: string) => `You read excerpts of recent sessions in the project "${project}" and keep its shared memory useful. Extract only durable knowledge that a future session working on this project would need: how to build, run or test something; a problem and its fix; a convention; a decision and its reason; an owner preference about the work. Skip task status, plans, progress and anything already covered by an existing note listed below. Write each item with jevellan_memory_inbox_add in a few sentences, with a short quote as evidence. Write nothing when nothing qualifies. Never include secrets, tokens or personal data.`;
export const dreamAppend = (project: string, commit: string) => `You are consolidating the shared memory of the project "${project}" for the night. Work through these steps in order.
1. Inbox: fold each inbox note into the existing note it belongs to, create a new note when it is new durable knowledge, or drop it when it is not durable.
2. Duplicates: merge notes that say the same thing and keep the clearer title.
3. Truth: check notes against the code in this worktree at ${commit}. Correct paths, commands and names that changed. Archive notes that are no longer true, with the reason.
4. Today's changes: add what the merged pull requests and commits listed below change about how the project works.
5. Project brief: rewrite the note "Project brief" in at most 2,000 characters: what the project is, how to build, run and test it, its conventions, its current areas of work and its known gotchas.
Never edit notes whose source is owner; link to them instead. Never delete; archive. End with exactly one jevellan_memory_dream_report.`;

/** Memory work uses Projects placement, launch, accounting, Git and sweep services. It never joins the ordered nightly tasks. */
export class ProjectMemoryProgramme {
  readonly dream: MemoryDream; readonly #active = new Map<string, { promise: Promise<void>; execution?: TurnExecution }>(); #closed = false;
  constructor(readonly o: { store: HubMemoryStore; captures: ProjectCaptureQueue; hub: ProjectHub; launcher: TurnLauncher; placement: Placement;
    git: ThreadGit; daily: ProjectDailyWork; deviceId: string; redactor: SecretRedactor; accounts: ConstructorParameters<typeof TurnExecution>[0]['accounts'];
    settings(projectId: string): Promise<import('@jevellan/core').ProjectWorkSettings>; repository(project: Project): string; baseBranch(repo: string): Promise<string>;
    event(projectId: string, event: CoordinatorEvent): Promise<void>; enterOperation(id: string, title: string): () => void; now(): number }) { this.dream = new MemoryDream(o.store); }
  path(projectId: string, kind: 'extraction' | 'dream') { return join(this.o.store.root(projectId), `${kind}-session.json`); }
  session(projectId: string, kind: 'extraction' | 'dream'): MemorySession | null { return existsSync(this.path(projectId, kind)) ? readDocument(this.path(projectId, kind), MemorySessionSchema) : null; }
  save(session: MemorySession) { writeDocument(this.path(session.projectId, session.kind), MemorySessionSchema, session); return session; }
  busy(projectId?: string) { return projectId ? this.#active.has(projectId) : this.#active.size > 0; }
  requests(projectId: string) { const directory = this.o.store.manager.homes.ensure('project-memory', projectId, 'dream-requests'); return readdirSync(directory).filter(file => file.endsWith('.json')).map(file => readDocument(join(directory, file), MemoryDreamRequestSchema)); }
  requestFile(projectId: string, requestId: string) { return join(this.o.store.manager.homes.ensure('project-memory', projectId, 'dream-requests'), `${IdSchema.parse(requestId)}.json`); }
  runNow(project: Project, requestId: string) {
    if (project.memory.mode !== 'hub') throw new Error('This project does not use hub memory.');
    const file = this.requestFile(project.id, requestId);
    if (!existsSync(file)) {
      if (this.requests(project.id).some(request => request.state !== 'finished') || this.busy(project.id)) throw new Error('This project already has memory work queued or running.');
      writeDocument(file, MemoryDreamRequestSchema, { schema: 'memory-dream-request-v1', id: requestId, projectId: project.id, state: 'pending', at: new Date(this.o.now()).toISOString() });
      void this.start(project, 'dream', false, undefined, requestId).catch(() => undefined);
    }
    return { schema: 'memory-dream-run-receipt-v1' as const, id: requestId, accepted: true as const };
  }
  line(projectId: string): string {
    const session = this.session(projectId, 'dream'), request = this.requests(projectId).find(row => row.state !== 'finished'), dream = this.dream.state(projectId);
    if (session?.state === 'failed' && (!dream || session.dreamId === dream.id)) return `Memory dream: failed — ${session.reason ?? 'The session failed.'}`;
    if (request?.reason && (!dream || Date.parse(request.at) > Date.parse(dream.startedAt))) return `Memory dream: queued — ${request.reason}`;
    return dream ? `Memory dream: ${dream.state}${dream.report ? ` — ${dream.report.summary}` : dream.reason ? ` — ${dream.reason}` : ''}` : 'Memory dream: not run.';
  }
  async publishDream(projectId: string) {
    const dream = this.dream.state(projectId); if (!dream?.report) return;
    await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'memory-dreamed', id: derivedId('cev', dream.id, dream.state, dream.report.toCommit), at: dream.completedAt!, summary: dream.report.summary, counts: dream.report.counts });
  }
  async applyDream(project: Project) {
    const state = await this.dream.apply(project); await this.publishDream(project.id);
    const windowId = this.session(project.id, 'dream')?.windowId;
    if (windowId) await this.o.daily.memoryFinished(project.id, windowId, this.line(project.id), false);
    return state;
  }
  async #recover(projectId: string) {
    if (this.busy(projectId)) return;
    for (const kind of ['extraction', 'dream'] as const) {
      const session = this.session(projectId, kind);
      if (session?.state !== 'running') {
        if (session?.requestId) { const file = this.requestFile(projectId, session.requestId), request = readDocument(file, MemoryDreamRequestSchema);
          if (request.state !== 'finished') writeDocument(file, MemoryDreamRequestSchema, { ...request, state: 'finished', ...(session.reason ? { reason: session.reason } : {}) }); }
        continue;
      }
      if (session.process) await endTurnProcess(session.process);
      this.save({ ...session, state: 'failed', endedAt: new Date(this.o.now()).toISOString(), reason: 'The hub restarted before this memory session finished.' });
      if (kind === 'dream') this.dream.fail(projectId, 'The hub restarted before the dream finished.');
      if (session.requestId) { const file = this.requestFile(projectId, session.requestId), request = readDocument(file, MemoryDreamRequestSchema); writeDocument(file, MemoryDreamRequestSchema, { ...request, state: 'finished', reason: 'The hub restarted before this memory session finished.' }); }
      if (session.windowId) await this.o.daily.memoryFinished(projectId, session.windowId, this.line(projectId), true);
    }
  }
  async sweep(project: Project): Promise<void> {
    if (this.#closed || project.memory.mode !== 'hub' || !project.paths[this.o.deviceId]) return;
    await this.#recover(project.id); const settings = await this.o.settings(project.id), dailies = await this.o.daily.dailies(project.id);
    if (!this.dream.watermark(project.id)) {
      const repo = this.o.repository(project), ref = `refs/jevellan/threads/memory_${project.id}/base`;
      try { const head = await this.o.git.fetchPrivate(repo, await this.o.baseBranch(repo), ref); if (head) this.dream.initialise(project.id, head); }
      finally { await this.o.git.run(repo, ['update-ref', '-d', ref]).catch(() => undefined); }
    }
    const pending = this.requests(project.id).find(request => request.state === 'pending');
    if (pending && !this.busy(project.id)) { void this.start(project, 'dream', false, undefined, pending.id).catch(() => undefined); return; }
    if (settings.nightlyWindow.enabled && !dailies.some(daily => daily.target.kind === 'memory-dream')) {
      await this.o.daily.createDaily(project.id, { schema: 'daily-create-request-v1', clientRequestId: 'shared_memory_dream', name: 'Memory dream', goalId: null, order: 0, enabled: true, target: { kind: 'memory-dream' } });
    }
    const window = (await this.o.daily.windows(project.id))[0], dream = this.dream.state(project.id);
    const nightlyItem = dailies.find(daily => daily.target.kind === 'memory-dream');
    const local = new Date(this.o.now()), day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2,'0')}-${String(local.getDate()).padStart(2,'0')}`;
    const prior = dream ? new Date(dream.startedAt) : null;
    const alreadyToday = prior && `${prior.getFullYear()}-${String(prior.getMonth()+1).padStart(2,'0')}-${String(prior.getDate()).padStart(2,'0')}` === day;
    const due = settings.nightlyWindow.enabled ? !!window && nightlyItem?.enabled && (!dream || Date.parse(dream.startedAt) < Date.parse(window.openedAt))
      : local.getHours() >= 3 && !alreadyToday;
    if (this.busy(project.id)) return;
    const previous = this.session(project.id, 'extraction'), input = this.o.captures.extractionInput(project.id);
    const sameFailed = previous?.state === 'failed' && previous.retries >= 1 && input.captures.every(capture => previous.captures.some(old => old.id === capture.id));
    const extractionDue = settings.memory.capture && input.bytes >= 4096 && !sameFailed && (due || !previous || this.o.now() >= Date.parse(previous.startedAt) + 1_800_000);
    if (extractionDue) this.start(project, 'extraction', !!due, due ? window?.id : undefined).catch(() => undefined);
    else if (due && dream?.state !== 'suggested') this.start(project, 'dream', false, window?.id).catch(() => undefined);
  }
  start(project: Project, kind: 'extraction' | 'dream', dreamAfter = false, windowId?: string, requestId?: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Project memory is closed.'));
    const prior = this.#active.get(project.id); if (prior) return prior.promise;
    const active: { promise: Promise<void>; execution?: TurnExecution } = { promise: Promise.resolve() };
    this.#active.set(project.id, active);
    active.promise = this.#run(project, kind, active, windowId, requestId).finally(() => this.#active.delete(project.id));
    if (dreamAfter) active.promise = active.promise.then(() => this.start(project, 'dream', false, windowId));
    return active.promise;
  }
  async #run(project: Project, kind: 'extraction' | 'dream', active: { execution?: TurnExecution }, windowId?: string, requestId?: string): Promise<void> {
    const work = await this.o.settings(project.id), title = kind === 'dream' ? 'Nightly memory dream' : 'Shared memory extraction';
    const placement = await this.o.placement.place({ project, workSettings: work, title, task: title, taskContext: { type: 'memory', needs: [], goal: null },
      fixed: { deviceId: this.o.deviceId, isolation: 'worktree', effort: kind === 'dream' ? 'high' : 'low' }, requiredEffort: kind === 'dream' ? 'high' : 'low', readOnly: true,
      coordinatorDeviceId: this.o.deviceId, ignoreRunningLimit: false });
    if (placement.kind === 'refused' || placement.atLimit) {
      const reason = placement.kind === 'refused' ? placement.message : 'The project has no available memory-session slot.';
      if (requestId) { const file = this.requestFile(project.id, requestId); writeDocument(file, MemoryDreamRequestSchema, { ...readDocument(file, MemoryDreamRequestSchema), reason: this.o.redactor.text(reason).slice(0, 1200) }); }
      if (windowId) await this.o.daily.memoryFinished(project.id, windowId, `Memory dream: blocked — ${reason}`, true);
      return;
    }
    const id = newId('msession'), directory = this.o.store.manager.homes.ensure('project-memory', project.id, 'sessions', id), cwd = join(directory, 'workspace'), inputFile = join(directory, 'input.md');
    const input = this.o.captures.extractionInput(project.id), previous = this.session(project.id, kind), notes = this.o.store.list(project.id);
    let session = this.save(MemorySessionSchema.parse({ schema: 'project-memory-session-v1', id, projectId: project.id, kind, state: 'running', startedAt: new Date(this.o.now()).toISOString(), placement: placement.record,
      captures: kind === 'extraction' ? input.captures : [], retries: previous?.state === 'failed' && kind === 'extraction' && input.captures.every(capture => previous.captures.some(old => old.id === capture.id)) ? previous.retries + 1 : 0, inbox: [], inputFile,
      ...(windowId ? { windowId } : {}), ...(requestId ? { requestId } : {}) }));
    if (requestId) { const file = this.requestFile(project.id, requestId); writeDocument(file, MemoryDreamRequestSchema, { ...readDocument(file, MemoryDreamRequestSchema), state: 'started', sessionId: id }); }
    const release = this.o.enterOperation(id, title), repo = kind === 'dream' ? this.o.repository(project) : undefined;
    let mainCommit: string | undefined, ref: string | undefined, tools: MemorySessionTools | undefined, clean = true;
    try {
      if (kind === 'extraction') { mkdirSync(cwd, { recursive: true }); atomicWrite(inputFile, `${input.text}\n\nActive note titles:\n${notes.map(note => `- ${note.title}`).join('\n')}`); }
      else {
        ref = `refs/jevellan/threads/${id}/base`; mainCommit = await this.o.git.fetchPrivate(repo!, await this.o.baseBranch(repo!), ref);
        await this.o.git.run(repo!, ['worktree', 'add', '--detach', cwd, mainCommit]);
        const state = await this.dream.begin(project, mainCommit, { source: 'dream', runtime: placement.record.runtime, model: placement.record.model }, work.memory.dreamMode);
        session = this.save({ ...session, dreamId: state.id, mainCommit });
        const candidates = collectMemoryCandidates(readMemoryFiles(this.o.store.notes(project.id), '.'), { changed: null, now: this.o.now() });
        const notebook = (await this.o.hub.notebook(project.id))?.document.content ?? '(empty)', lastReview = (await this.o.daily.view(project.id)).lastReview;
        const previousCommit = this.dream.watermark(project.id) ?? mainCommit;
        if ((await this.o.git.run(repo!, ['merge-base', '--is-ancestor', previousCommit, mainCommit], { permitted: [1] })).code !== 0) throw new Error('Main no longer contains the last dream commit; reconcile its history before dreaming.');
        const commits = (await this.o.git.run(cwd, ['log', '--format=%H %an %s', '--name-only', `${previousCommit}..${mainCommit}`], { timeoutMs: 300_000 })).stdout;
        const staged = this.o.store.project(project, { kind: 'memory', provenance: state.provenance, stagingId: state.id }, this.dream.staging(state));
        atomicWrite(inputFile, this.o.redactor.text(`Inbox notes:\n${notes.filter(note => note.permalink.startsWith('inbox/')).map(note => `${note.permalink}\n${note.content}`).join('\n\n')}\n\nMemory care candidates:\n${JSON.stringify(candidates)}\n\nMain changes:\n${commits}\n\nLast night's review:\n${JSON.stringify(lastReview)}\n\nCoordinator notebook (read-only):\n${notebook}`));
        tools = new MemorySessionTools('dream', staged, this.o.redactor, { archive: input => this.o.store.archive(project, { kind: 'memory', provenance: state.provenance }, input, AbortSignal.timeout(150_000), this.dream.staging(state)),
          report: async summary => { session = this.save({ ...session, summary }); return { schema: 'memory-dream-receipt-v1', accepted: true }; } });
      }
      tools ??= new MemorySessionTools('extraction', this.o.store.project(project, { kind: 'viewer' }), this.o.redactor, { inbox: async note => {
        if (note.evidence.threadId && !session.captures.some(capture => capture.threadId === note.evidence.threadId) || note.evidence.taskId && !session.captures.some(capture => capture.taskId === note.evidence.taskId)) throw new Error('Evidence must name a thread or task in these supplied excerpts.');
        session = this.save({ ...session, inbox: [...session.inbox, note] }); return { schema: 'memory-inbox-receipt-v1', accepted: true };
      } });
      const launched = await this.o.launcher.launch({ owner: { kind: 'memory', projectId: project.id, id }, turn: 1, runtime: placement.record.runtime, modelId: placement.record.modelId,
        model: placement.record.model, modelLabel: placement.labels.modelLabel, effort: kind === 'dream' ? 'high' : 'low', pinnedAccountId: placement.record.accountId,
        permissions: 'read-only', cwd, safetyProfile: 'memory', systemAppend: kind === 'dream' ? dreamAppend(project.name, mainCommit!) : extractionAppend(project.name),
        prompt: () => `Read the complete memory session input at ${inputFile}. ${kind === 'dream' ? 'Search and read the notes before consolidating them. All memory edits go through the shared memory tools.' : 'Extract zero to eight durable items. Write nothing when none qualify.'}`, tools, timeoutMs: kind === 'dream' ? 7_200_000 : 1_200_000, memoryMode: 'hub' });
      if (launched.kind === 'unavailable') throw new Error(launched.reason);
      clean = false;
      try {
        active.execution = new TurnExecution({ run: launched.run, accountId: launched.accountId, secretRef: launched.secretRef, model: placement.record.model, deviceId: this.o.deviceId,
          accounts: this.o.accounts, redactor: this.o.redactor, initialUsage: launched.usage, onSession: () => {}, onProcess: native => { session = this.save({ ...session, process: { turn: 1, startedAt: session.startedAt, ...native } }); } });
        if (this.#closed) await active.execution.shutdown();
        const outcome = await active.execution.done; clean = true;
        const { process: _process, ...ended } = session; void _process; session = this.save({ ...ended, usage: outcome.usage });
        if (outcome.status !== 'completed') throw new Error(outcome.error?.message ?? `The memory session ended ${outcome.status}.`);
        if (kind === 'dream') {
          if (!tools.reported) throw new Error('The dream ended without its required report.');
          if (await this.o.git.resolve(cwd, 'HEAD') !== mainCommit || (await this.o.git.run(cwd, ['status', '--porcelain', '--untracked-files=all'])).stdout) throw new Error('The read-only dream changed its code worktree.');
          await this.dream.finish(project, tools.summary!); await this.publishDream(project.id);
        } else {
          if (readdirSync(cwd).length) throw new Error('The read-only extraction changed its empty workspace.');
          for (const note of session.inbox) {
            const source = session.captures.find(capture => note.evidence.threadId ? capture.threadId === note.evidence.threadId : note.evidence.taskId ? capture.taskId === note.evidence.taskId : false)
              ?? this.o.captures.slices(project.id).find(slice => session.captures.some(capture => capture.id === slice.capture.id) && !!note.evidence.quote && slice.text.includes(note.evidence.quote))?.capture ?? session.captures[0];
            const title = `${note.title} (inbox ${id.slice(-8)})`, writer = this.o.store.project(project, { kind: 'memory', provenance: { source: 'capture', runtime: source?.runtime ?? placement.record.runtime, model: source?.model ?? placement.record.model,
              ...(note.evidence.threadId ? { threadId: note.evidence.threadId } : {}), ...(note.evidence.taskId ? { taskId: note.evidence.taskId } : {}) } }, undefined, `${id}_${session.inbox.indexOf(note)}`, 'inbox');
            const body = `${note.body}\n\nKind: ${note.kind}\nEvidence: ${note.evidence.quote}`;
            if (!this.o.store.list(project.id).some(existing => existing.permalink.startsWith('inbox/') && existing.content.includes(body))) await writer.write({ title, content: body }, AbortSignal.timeout(150_000));
          }
          this.o.captures.processed(project.id, session.captures, id);
        }
        this.save({ ...session, state: 'completed', endedAt: new Date(this.o.now()).toISOString() });
      } finally { await launched.release(); }
    } catch (error) {
      const reason = this.o.redactor.text(error instanceof Error ? error.message : 'The memory session failed.').slice(0, 1200);
      this.save({ ...session, state: 'failed', endedAt: new Date(this.o.now()).toISOString(), reason }); if (kind === 'dream') this.dream.fail(project.id, reason);
    } finally {
      await tools?.close();
      if (requestId) { const file = this.requestFile(project.id, requestId); writeDocument(file, MemoryDreamRequestSchema, { ...readDocument(file, MemoryDreamRequestSchema), state: 'finished', ...(this.session(project.id, kind)?.reason ? { reason: this.session(project.id, kind)!.reason } : {}) }); }
      if (windowId && kind === 'dream') await this.o.daily.memoryFinished(project.id, windowId, this.line(project.id), this.session(project.id, kind)?.state === 'failed');
      if (clean) { if (kind === 'dream' && existsSync(cwd)) await this.o.git.run(repo!, ['worktree', 'remove', '--force', cwd]).catch(() => undefined); else rmSync(cwd, { recursive: true, force: true });
        if (ref) await this.o.git.run(repo!, ['update-ref', '-d', ref]).catch(() => undefined); }
      release();
    }
  }
  async close() { this.#closed = true; await Promise.allSettled([...this.#active.values()].map(active => active.execution?.shutdown())); await Promise.allSettled([...this.#active.values()].map(active => active.promise)); }
}
