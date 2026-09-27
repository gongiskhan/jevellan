import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { z } from 'zod';
import {
  BackgroundDraftResultSchema, CheckoutOwnership, ContextDraftSchema, GitWorkspace, Homes, ImproverDeviceAckSchema, ImproverDeviceWorkSchema, ImproverJobSchema, MemoryCareReportRowSchema,
  IdSchema, MemoryCareStateResultSchema, MemoryPatchDraftSchema, ProjectPatchSchema, ProjectSuggestionInputSchema, ProjectSuggestionRowSchema, ProjectTaskSchema, atomicWrite, inside, readDocument, resolveProjectPath, resolvedPath, stableJson, writeDocument,
  type BackgroundDraftRequest, type BackgroundDraftResult, type CheckoutOwner, type ImproverDeviceRequest, type ImproverDeviceWork, type ImproverJob, type MemoryCareCounts,
  type MemoryCareState, type MemoryNoteRef, type Project, type ProjectPatch, type ProjectSuggestionInput, type ProjectTask, type ProjectTaskResult, type PublicationLeaseService, type SecretRedactor,
} from '@jevellan/core';
import { ConversationLedger, publishWorkspace } from '@jevellan/conversations';
import { SAME_NOTE_THRESHOLD, STILL_USEFUL_THRESHOLD, WORKING_RULE_THRESHOLD, judgeContextRules, judgeMemoryCare, type DecisionClient } from '@jevellan/decisions';
import {
  careInvolved, careKey, collectMemoryCandidates, mergeClusters, memoryCareCommit, memoryCarePatch, memoryCareResult, noteRef, patchFile, projectPatch, readMemoryFiles, searchOverlapPairs, sha256,
  type ConfirmedCare, type MemoryFile,
} from '@jevellan/memory';

const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const MAX_SEARCHES = 30;
export type MemoryPort = { sync(signal: AbortSignal): Promise<void>; search(query: string, signal: AbortSignal): Promise<Array<{ permalink: string }>> };
type Options = {
  deviceId: string; deviceName: string; homes: Homes; redactor: SecretRedactor; ready: Promise<void>;
  hub(input: ImproverDeviceRequest): Promise<unknown>;
  projects(): Promise<Project[]>;
  ownership: CheckoutOwnership; leases: PublicationLeaseService;
  assertOutsideIdle(project: Project, path: string): Promise<void>;
  memory(project: Project): MemoryPort;
  client(): DecisionClient | Promise<DecisionClient>; jevModel(): Promise<string>;
  draft(request: BackgroundDraftRequest, signal: AbortSignal): Promise<BackgroundDraftResult>;
  handoffs(projectId: string): string[];
  enterOperation(id: string, title: string): () => void;
  pollMs?: number; now?: () => number;
};
type Applied = { status: 'applied'; commit: string | null; published: boolean } | { status: 'stale'; note: string } | { status: 'refused'; note: string };
class Skip extends Error {}
const ApplyJournalSchema = z.strictObject({ schema: z.literal('improver-apply-journal-v1'), projectId: IdSchema, patch: ProjectPatchSchema });
class Busy extends Error { constructor(message: string, readonly inUse: boolean) { super(message); } }

/** Runs per-project improver jobs and checkout tasks on the device that has the checkout. */
export class ProjectImprover {
  readonly #startedAt = new Date().toISOString();
  readonly #abort = new AbortController();
  readonly careHomes: Homes;
  #timer: ReturnType<typeof setInterval> | undefined;
  #tick: Promise<void> | undefined;
  #again = false;
  #closed = false;
  #recovered = false;
  constructor(readonly options: Options) {
    this.careHomes = new Homes(options.homes.ensure('improver', 'care'), options.homes.userHome);
  }
  #now() { return (this.options.now ?? Date.now)(); }
  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.options.pollMs ?? 60_000); this.#timer.unref();
    void this.tick().catch(() => undefined);
  }
  /** Asks the hub for work now; overlapping requests coalesce into one more pass. */
  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#tick) { this.#again = true; return this.#tick; }
    this.#tick = this.options.ready.then(async () => {
      do { this.#again = false; if (!this.#closed) await this.#pass(); } while (this.#again && !this.#closed);
    }).finally(() => { this.#tick = undefined; });
    return this.#tick;
  }
  async idle(): Promise<void> { while (this.#tick) await this.#tick.catch(() => undefined); }
  async close(): Promise<void> { this.#closed = true; clearInterval(this.#timer); this.#abort.abort(); await this.#tick?.catch(() => undefined); }
  async #device<T>(schema: z.ZodType<T>, input: ImproverDeviceRequest): Promise<T> { return schema.parse(await this.options.hub(input)); }
  async #pass(): Promise<void> {
    if (!this.#recovered) { await this.#recover(await this.options.projects()); this.#recovered = true; }
    const work = await this.#device(ImproverDeviceWorkSchema, { schema: 'improver-device-request-v1', operation: 'poll', startedAt: this.#startedAt });
    const projects = new Map((await this.options.projects()).map(project => [project.id, project]));
    for (const job of work.jobs) {
      if (this.#closed) return;
      await this.#job(job, projects.get(job.scope.projectId!) ?? null, work).catch(() => undefined);
    }
    for (const entry of work.tasks) {
      if (this.#closed) return;
      await this.#task(entry, projects.get(entry.task.projectId) ?? null).catch(() => undefined);
    }
  }
  #path(project: Project): string | null { try { return resolveProjectPath(project, this.options.deviceId); } catch { return null; } }
  #owner(id: string, title: string): CheckoutOwner { const key = `improver_${hash(id).slice(0, 40)}`; return { conversationId: key, conversationTitle: title, workId: key }; }
  #git(project: Project, kind: 'memory-care' | 'context') { return project.branchPolicy === 'main' && (kind === 'context' || project.memory.mode === 'repo'); }

  async #job(job: ImproverJob, project: Project | null, work: ImproverDeviceWork): Promise<void> {
    const release = this.options.enterOperation(job.id, job.scope.kind === 'memory' ? 'Memory care' : 'Context suggestions');
    const renewal = setInterval(() => { void this.#device(ImproverJobSchema, { schema: 'improver-device-request-v1', operation: 'renew', job }).catch(() => undefined); }, 30_000); renewal.unref();
    const note = (stage: Parameters<ProjectImprover['note']>[1], text: string) => this.note(job, stage, text);
    let careState: MemoryCareState | null = null;
    try {
      await note('started', job.scope.kind === 'memory' ? 'Checking project memory.' : 'Looking for working rules in project memory.');
      if (!project || !this.#path(project)) throw new Skip(`skipped: ${project?.name ?? 'this project'} is not checked out on ${this.options.deviceName}`);
      const result = job.scope.kind === 'memory' ? await this.#memoryCare(job, project, work, state => { careState = state; }) : await this.#contextJob(job, project, work);
      await note('complete', result);
      await this.#device(ImproverJobSchema, { schema: 'improver-device-request-v1', operation: 'finish', job, status: 'complete', note: result, careState });
    } catch (error) {
      const message = this.options.redactor.text(error instanceof Error ? error.message : 'The improver job could not complete.').slice(0, 1200);
      const status = error instanceof Skip ? 'skipped' : 'failed';
      await note(status === 'skipped' ? 'skipped' : 'failed', message).catch(() => undefined);
      await this.#device(ImproverJobSchema, { schema: 'improver-device-request-v1', operation: 'finish', job, status, note: message, careState: null }).catch(() => undefined);
    } finally { clearInterval(renewal); release(); }
  }
  async note(job: ImproverJob, stage: 'started' | 'synchronized' | 'collected' | 'judged' | 'drafted' | 'applied' | 'published' | 'suggested' | 'skipped' | 'complete' | 'failed', text: string): Promise<void> {
    await this.#device(ImproverDeviceAckSchema, { schema: 'improver-device-request-v1', operation: 'log', job, stage, note: text });
  }
  /** Free checkout, no outside agent, then the caller's work under ownership. */
  async #owned<T>(project: Project, owner: CheckoutOwner, run: (workspace: GitWorkspace) => Promise<T>): Promise<T> {
    const path = this.#path(project)!;
    const claim = await this.options.ownership.current(project);
    if (claim?.held && (claim.conversationId !== owner.conversationId || claim.workId !== owner.workId)) throw new Busy(`${project.name} on ${this.options.deviceName} is in use by "${claim.conversationTitle}".`, true);
    try { await this.options.assertOutsideIdle(project, path); } catch (error) { throw new Busy(error instanceof Error ? error.message : 'Another agent is active in this project.', false); }
    await this.options.ownership.acquire(project, owner);
    return run(new GitWorkspace(project, this.options.deviceId, this.options.ownership, owner, this.options.redactor));
  }
  async #release(workspace: GitWorkspace, commits: 'published' | 'discarded' | 'unchanged'): Promise<void> {
    await this.options.ownership.release(workspace.project, workspace.owner, { processesGone: true, commits });
    const journal = this.#journal(workspace.owner.conversationId); if (existsSync(journal)) unlinkSync(journal);
  }
  #journal(id: string) { this.careHomes.ensure('applying'); return this.careHomes.at('applying', `${IdSchema.parse(id)}.json`); }
  #ancestor(root: string, commit: string, of: string): boolean {
    try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, of], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } }); return true; } catch { return false; }
  }
  /**
   * A checkout left owned by an improver operation of a stopped process is returned to where it started:
   * written patch text is restored and unpublished improver commits are discarded to a saved ref.
   * Anything unexpected keeps ownership for inspection.
   */
  async #recover(projects: Project[]): Promise<void> {
    for (const project of projects) {
      const root = this.#path(project); if (!root) continue;
      const claim = await this.options.ownership.current(project).catch(() => null);
      if (!claim?.held || !claim.conversationId.startsWith('improver_') || claim.deviceId !== this.options.deviceId || claim.pid === process.pid) continue;
      try { process.kill(claim.pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      const owner = { conversationId: claim.conversationId, conversationTitle: claim.conversationTitle, workId: claim.workId };
      try {
        await this.options.ownership.acquire(project, owner);
        const workspace = new GitWorkspace(project, this.options.deviceId, this.options.ownership, owner, this.options.redactor);
        const journal = this.#journal(owner.conversationId);
        if (existsSync(journal)) { const { patch } = readDocument(journal, ApplyJournalSchema); if (this.#matches(root, patch, 'after')) this.#write(root, patch, 'before'); }
        if (project.branchPolicy !== 'main') { await this.#release(workspace, 'unchanged'); continue; }
        if (!await workspace.clean()) continue;
        const upstream = await workspace.upstream(); const head = await workspace.head();
        if (head !== upstream && await workspace.contains(upstream)) { await workspace.discard(upstream, head, 3, () => undefined); await this.#release(workspace, 'discarded'); }
        else if (head === upstream || this.#ancestor(root, head, upstream)) await this.#release(workspace, 'unchanged');
      } catch { /* Ownership stays held; the checkout needs inspection. */ }
    }
  }

  /** Step 1 of memory care: fast-forward a free, clean checkout and refresh the isolated index. */
  async #synchronize(job: ImproverJob, project: Project): Promise<string | null> {
    const owner = this.#owner(`${job.id}_sync`, 'Memory care');
    let head: string | null = null;
    try {
      await this.#owned(project, owner, async workspace => {
        try { if (this.#git(project, 'memory-care')) head = await workspace.prepare(); }
        catch (error) { await this.#release(workspace, 'unchanged'); throw new Skip(`skipped: ${error instanceof Error ? error.message : `${project.name} is not clean`}`); }
        await this.#release(workspace, 'unchanged');
      });
    } catch (error) {
      if (error instanceof Busy) throw new Skip(error.inUse ? `skipped: ${project.name} is in use` : `skipped: ${error.message}`);
      throw error;
    }
    try { await this.options.memory(project).sync(this.#abort.signal); await this.note(job, 'synchronized', 'Synchronized the checkout and the memory index.'); }
    catch (error) { await this.note(job, 'synchronized', `The memory index could not be refreshed, so search overlap was not used: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 1200)); return head; }
    return head;
  }
  #changed(project: Project, root: string, files: MemoryFile[], state: MemoryCareState | null): Set<string> | null {
    if (!state) return null;
    if (this.#git(project, 'memory-care') && state.lastCommit) {
      try {
        const output = execFileSync('git', ['-C', root, 'diff', '--name-only', '--no-renames', '-z', state.lastCommit, 'HEAD', '--', project.memory.dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
        return new Set(output.split('\0').filter(Boolean));
      } catch { return null; }
    }
    return new Set(files.filter(file => file.modifiedAt > Date.parse(state.lastRunAt)).map(file => file.path));
  }
  async #searchPairs(project: Project, files: MemoryFile[], changed: Set<string> | null): Promise<Array<[string, string]>> {
    const memory = this.options.memory(project); const results = new Map<string, string[]>();
    const byPermalink = new Map(files.map(file => [file.permalink, file.path]));
    const targets = files.filter(file => !file.archived && (!changed || changed.has(file.path))).slice(0, MAX_SEARCHES);
    try {
      for (const file of targets) {
        const words = (file.title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16);
        if (!words.length) continue;
        const hits = await memory.search(words.join(' OR '), this.#abort.signal);
        results.set(file.path, hits.map(hit => byPermalink.get(hit.permalink)).filter((path): path is string => !!path && path !== file.path));
      }
      // Reverse lookups for changed notes' partners keep overlap mutual rather than one-sided.
      for (const path of new Set([...results.values()].flat())) {
        if (results.has(path) || results.size >= MAX_SEARCHES * 2) continue;
        const file = files.find(entry => entry.path === path)!; const words = (file.title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16);
        if (!words.length) continue;
        const hits = await memory.search(words.join(' OR '), this.#abort.signal);
        results.set(path, hits.map(hit => byPermalink.get(hit.permalink)).filter((value): value is string => !!value && value !== path));
      }
    } catch { return []; }
    return searchOverlapPairs(results);
  }

  /** Collect, judge, draft and build one checked patch from the current checkout files. */
  async #careProposal(job: { id: string }, project: Project, state: MemoryCareState | null, log: (stage: 'collected' | 'judged' | 'drafted', text: string) => Promise<void>, known: string[]): Promise<{ patch: ProjectPatch; counts: MemoryCareCounts; evidence: MemoryNoteRef[]; key: string; files: MemoryFile[] } | string> {
    const root = this.#path(project)!; const files = readMemoryFiles(root, project.memory.dir);
    const changed = this.#changed(project, root, files, state);
    const candidates = collectMemoryCandidates(files, { changed, now: this.#now(), searchPairs: await this.#searchPairs(project, files, changed) });
    await log('collected', `${candidates.notes.length} notes: ${candidates.pairs.length} possible duplicates, ${candidates.unresolved.length} unresolved, ${candidates.stale.length} stale, ${candidates.brokenLinks.length} broken links.`);
    if (!candidates.pairs.length && !candidates.unresolved.length && !candidates.stale.length && !candidates.brokenLinks.length) return 'Nothing to tidy.';
    const notes = new Map(files.map(file => [file.path, { title: file.title, content: file.content }]));
    const judgment = await judgeMemoryCare(await this.options.client(), { candidates, notes, project: project.name, handoffs: this.options.handoffs(project.id), model: await this.options.jevModel() }, this.#abort.signal);
    const confirmed: ConfirmedCare = { pairs: judgment.pairs.filter(pair => pair.probability >= SAME_NOTE_THRESHOLD).map(pair => [pair.a, pair.b]),
      stale: judgment.stale.filter(note => note.probability <= STILL_USEFUL_THRESHOLD).map(note => note.path), unresolved: candidates.unresolved, brokenLinks: candidates.brokenLinks };
    await log('judged', `Jev confirmed ${confirmed.pairs.length} duplicate pair${confirmed.pairs.length === 1 ? '' : 's'} and ${confirmed.stale.length} stale note${confirmed.stale.length === 1 ? '' : 's'}.`);
    const involved = careInvolved(confirmed); if (!involved.length) return 'Nothing to tidy.';
    const key = careKey('memory-care', files, involved);
    if (known.includes(key)) return 'These notes already have a suggestion waiting for your decision.';
    const needsDraft = confirmed.pairs.length || confirmed.unresolved.length || confirmed.brokenLinks.length;
    const content = needsDraft ? await this.#careDraft(job.id, project, files, confirmed) : { schema: 'memory-patch-draft-v1', summary: 'Archive stale notes.', files: [] };
    const { patch, counts } = memoryCarePatch(project.memory.dir, files, confirmed, content);
    if (needsDraft) await log('drafted', 'A read-only memory-care step returned a patch.');
    if (!patch) return 'Nothing to tidy.';
    const evidence = involved.map(path => files.find(file => file.path === path)!).map(noteRef);
    return { patch, counts, evidence, key, files };
  }
  async #careDraft(id: string, project: Project, files: MemoryFile[], confirmed: ConfirmedCare): Promise<unknown> {
    const relative = (path: string) => files.find(file => file.path === path)!.relative;
    const involved = new Set(careInvolved(confirmed));
    const copies = files.filter(file => !file.archived && (involved.has(file.path) && !confirmed.stale.includes(file.path) || file.links.length));
    const request: BackgroundDraftRequest = { schema: 'background-draft-request-v1', id: `care_${hash([id, careKey('memory-care', files, [...involved])])}`, title: `Memory care · ${project.name}`, projectId: project.id, resultType: 'memory-patch',
      brief: [
        'Tidy this project\'s memory notes. The files under memory/ are private read-only copies of the notes; do not edit them.',
        'tasks.json lists the work Jev confirmed. Each entry in "merge" is a group of notes that describe the same thing: combine the whole group into one of its notes, keeping every distinct fact and the best title, and return every other note of the group with content null.',
        'For each note in "reconcile", rewrite the conflicting versions into one current version, remove "status: unresolved" from its frontmatter and keep the superseded text under a "## History" section at the end.',
        'For each entry in "fixLinks", point the link at the right existing note listed in notes.json, or remove the link if nothing fits. Also update links in other notes that pointed at a merged-away note.',
        'Notes in "archive" are moved by Jevellan; do not change them. Do not create new notes.',
        'Return a memory-patch-draft-v1 JSON object matching draft-schema.json as handoff.result.content with type memory-patch. List only notes whose content changes, with paths relative to the memory folder.',
      ].join('\n'),
      files: {
        ...Object.fromEntries(copies.map(file => [`memory/${file.relative}`, file.content])),
        'notes.json': JSON.stringify(files.filter(file => !file.archived).map(file => ({ path: file.relative, title: file.title, permalink: file.permalink }))),
        'tasks.json': JSON.stringify({ merge: mergeClusters(confirmed.pairs).map(cluster => cluster.map(relative)), reconcile: confirmed.unresolved.map(relative), fixLinks: confirmed.brokenLinks.map(link => ({ note: relative(link.path), target: link.target })), archive: confirmed.stale.map(relative) }),
        'draft-schema.json': JSON.stringify(z.toJSONSchema(MemoryPatchDraftSchema)),
      } };
    const result = BackgroundDraftResultSchema.parse(await this.options.draft(request, this.#abort.signal));
    if (result.runId !== request.id || result.handoff.status !== 'done' || result.handoff.result?.type !== 'memory-patch') throw new Error('The memory-care step did not return a completed patch.');
    return typeof result.content === 'string' ? JSON.parse(result.content) : result.content;
  }
  async #memoryCare(job: ImproverJob, project: Project, work: ImproverDeviceWork, recordState: (state: MemoryCareState) => void): Promise<string> {
    const mode = work.settings.memory.mode;
    // One memory care suggestion per project waits at a time; the next run starts after you decide.
    if (mode === 'suggest' && work.open[project.id]?.includes('memory-care')) return 'A memory care suggestion for this project is waiting for your decision.';
    const state = (await this.#device(MemoryCareStateResultSchema, { schema: 'improver-device-request-v1', operation: 'care-state', projectId: project.id })).state;
    for (let attempt = 1; ; attempt++) {
      const head = await this.#synchronize(job, project);
      const markState = () => recordState({ schema: 'memory-care-state-v1', projectId: project.id, deviceId: this.options.deviceId, lastRunAt: new Date(this.#now()).toISOString(), lastCommit: head });
      const proposal = await this.#careProposal(job, project, state, (stage, text) => this.note(job, stage, text), mode === 'suggest' ? work.knownKeys[project.id] ?? [] : []);
      if (typeof proposal === 'string') { markState(); return proposal; }
      const result = memoryCareResult(proposal.counts);
      if (mode === 'suggest') {
        await this.#device(ProjectSuggestionRowSchema, { schema: 'improver-device-request-v1', operation: 'suggest', job, suggestion: this.#careSuggestion(`care_${hash([job.id, proposal.key])}`, project, proposal) });
        await this.note(job, 'suggested', `Suggested: ${result}.`); markState(); return `Suggested: ${result}`;
      }
      const applied = await this.#apply(project, this.#owner(job.id, 'Memory care'), proposal.patch, { action: 'memory', summary: memoryCareCommit(proposal.counts) });
      if (applied.status === 'stale' && attempt < 2) { await this.note(job, 'applied', 'Notes changed while memory care ran. Recomputing once.'); continue; }
      if (applied.status !== 'applied') throw new Skip(`skipped: ${applied.note}`);
      await this.note(job, applied.published ? 'published' : 'applied', applied.commit ? `Committed ${applied.commit.slice(0, 12)}${applied.published ? ' and published it' : ''}.` : 'Applied the changes on this device.');
      await this.#device(MemoryCareReportRowSchema, { schema: 'improver-device-request-v1', operation: 'report', job, report: { schema: 'memory-care-report-input-v1', projectId: project.id,
        projectName: project.name, counts: proposal.counts, evidence: proposal.evidence, patch: proposal.patch, commit: applied.commit, published: applied.published } });
      recordState({ schema: 'memory-care-state-v1', projectId: project.id, deviceId: this.options.deviceId, lastRunAt: new Date(this.#now()).toISOString(), lastCommit: applied.commit ?? head });
      return result;
    }
  }
  #careSuggestion(id: string, project: Project, proposal: { patch: ProjectPatch; counts: MemoryCareCounts; evidence: MemoryNoteRef[]; key: string }): ProjectSuggestionInput {
    return ProjectSuggestionInputSchema.parse({ schema: 'project-suggestion-input-v1', id, kind: 'memory-care', projectId: project.id, projectName: project.name,
      title: `Suggested memory care for ${project.name}`, reason: `${memoryCareResult(proposal.counts)}. Jev confirmed the duplicates and stale notes; unresolved notes and broken links were collected in code.`,
      evidence: proposal.evidence.slice(0, 100), counts: proposal.counts, patch: proposal.patch, suppressionKey: proposal.key });
  }

  /** The file an AGENTS.md addition changes: AGENTS.md, or the file it links to. */
  #instructionFile(root: string): { path: string; content: string | null } {
    const agents = join(root, 'AGENTS.md'); let info;
    try { info = lstatSync(agents); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: 'AGENTS.md', content: null }; throw error; }
    if (info.isSymbolicLink()) {
      const target = posix.normalize(readlinkSync(agents));
      if (target !== 'CLAUDE.md' || !existsSync(join(root, 'CLAUDE.md')) || lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink()) throw new Error('AGENTS.md links somewhere Jevellan does not edit.');
      return { path: 'CLAUDE.md', content: readFileSync(join(root, 'CLAUDE.md'), 'utf8') };
    }
    if (!info.isFile()) throw new Error('AGENTS.md is not a regular file.');
    return { path: 'AGENTS.md', content: readFileSync(agents, 'utf8') };
  }
  #ruleGroups(files: MemoryFile[], pairs: Array<[string, string]>): string[][] {
    const live = files.filter(file => !file.archived); const parent = new Map(live.map(file => [file.path, file.path]));
    const find = (path: string): string => { const next = parent.get(path)!; return next === path ? path : find(next); };
    for (const [a, b] of pairs) if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
    const groups = new Map<string, string[]>();
    for (const file of live) groups.set(find(file.path), [...groups.get(find(file.path)) ?? [], file.path]);
    return [...groups.values()].filter(group => group.length >= 3).map(group => group.sort().slice(0, 8)).slice(0, 10);
  }
  async #contextProposal(id: string, project: Project, paths: string[] | null, known: string[], log: (stage: 'collected' | 'judged' | 'drafted', text: string) => Promise<void>): Promise<ProjectSuggestionInput[] | string> {
    const root = this.#path(project)!; const files = readMemoryFiles(root, project.memory.dir); const instruction = this.#instructionFile(root);
    let groups: string[][];
    if (paths) groups = [paths.filter(path => files.some(file => file.path === path && !file.archived))];
    else {
      const candidates = collectMemoryCandidates(files, { changed: null, now: this.#now(), searchPairs: await this.#searchPairs(project, files, null) });
      groups = this.#ruleGroups(files, candidates.pairs.map(pair => [pair.a, pair.b]));
      await log('collected', `${groups.length} group${groups.length === 1 ? '' : 's'} of related notes.`);
    }
    groups = groups.filter(group => group.length >= 2 && !known.includes(careKey('context', files, group)));
    if (!groups.length) return 'No working rules to suggest.';
    const notes = new Map(files.map(file => [file.path, { title: file.title, content: file.content }]));
    const judgment = await judgeContextRules(await this.options.client(), { groups, notes, project: project.name, instructions: instruction.content ?? '', model: await this.options.jevModel() }, this.#abort.signal);
    const confirmed = judgment.groups.filter(group => group.probability >= WORKING_RULE_THRESHOLD).map(group => group.paths);
    await log('judged', `Jev confirmed ${confirmed.length} working rule${confirmed.length === 1 ? '' : 's'}.`);
    const suggestions: ProjectSuggestionInput[] = [];
    for (const group of confirmed) {
      const key = careKey('context', files, group); const members = group.map(path => files.find(file => file.path === path)!);
      const request: BackgroundDraftRequest = { schema: 'background-draft-request-v1', id: `context_${hash([id, key])}`, title: `Context suggestion · ${project.name}`, projectId: project.id, resultType: 'suggestion',
        brief: `Several project memory notes under notes/ state the same working rule. Draft a short addition to the project's instruction file ${instruction.path} that states this rule once, clearly, in the style of the existing file. Change nothing else. Return a context-draft-v1 JSON object matching draft-schema.json as handoff.result.content with type suggestion, where "after" is the complete new ${instruction.path}. Name ${instruction.path} in the title if you mention the file. Do not edit files.`,
        files: { [instruction.path]: instruction.content ?? '', ...Object.fromEntries(members.map(file => [`notes/${file.relative}`, file.content])), 'draft-schema.json': JSON.stringify(z.toJSONSchema(ContextDraftSchema)) } };
      const result = BackgroundDraftResultSchema.parse(await this.options.draft(request, this.#abort.signal));
      if (result.runId !== request.id || result.handoff.status !== 'done' || result.handoff.result?.type !== 'suggestion') throw new Error('The context step did not return a completed suggestion.');
      const draft = ContextDraftSchema.parse(typeof result.content === 'string' ? JSON.parse(result.content) : result.content);
      await log('drafted', `Drafted "${draft.title}".`);
      if (draft.after === (instruction.content ?? '')) continue;
      suggestions.push(ProjectSuggestionInputSchema.parse({ schema: 'project-suggestion-input-v1', id: `context_${hash([id, key])}`, kind: 'context', projectId: project.id, projectName: project.name,
        title: draft.title, reason: draft.reason, evidence: members.map(noteRef), counts: null, patch: projectPatch([patchFile(instruction.path, instruction.content, draft.after)]), suppressionKey: key }));
    }
    return suggestions.length ? suggestions : 'No working rules to suggest.';
  }
  async #contextJob(job: ImproverJob, project: Project, work: ImproverDeviceWork): Promise<string> {
    if (project.branchPolicy !== 'main') throw new Skip(`skipped: ${project.name} follows its own git rules`);
    const proposal = await this.#contextProposal(job.id, project, null, work.knownKeys[project.id] ?? [], (stage, text) => this.note(job, stage, text));
    if (typeof proposal === 'string') return proposal;
    for (const suggestion of proposal) await this.#device(ProjectSuggestionRowSchema, { schema: 'improver-device-request-v1', operation: 'suggest', job, suggestion });
    await this.note(job, 'suggested', `${proposal.length} context suggestion${proposal.length === 1 ? '' : 's'} ready.`);
    return `${proposal.length} context suggestion${proposal.length === 1 ? '' : 's'} ready.`;
  }

  #matches(root: string, patch: ProjectPatch, side: 'before' | 'after'): boolean {
    return patch.files.every(file => {
      const expected = side === 'before' ? file.before : file.after === null ? null : sha256(file.after);
      const path = join(root, file.path);
      let info; try { info = lstatSync(path); } catch { return expected === null; }
      return info.isFile() && expected !== null && sha256(readFileSync(path, 'utf8')) === expected;
    });
  }
  #write(root: string, patch: ProjectPatch, side: 'before' | 'after'): void {
    for (const file of patch.files) {
      const path = join(root, file.path); const content = side === 'after' ? file.after : file.beforeText;
      if (resolvedPath(path) !== path || !inside(root, path)) throw new Error('A patch path cannot leave the project or follow a link.');
      if (content === null) { if (existsSync(path)) unlinkSync(path); continue; }
      mkdirSync(dirname(path), { recursive: true }); atomicWrite(path, content, 0o644);
    }
  }
  /** Hash-checked apply under checkout ownership; Git projects commit and publish, and a failed publication is discarded. */
  async #apply(project: Project, owner: CheckoutOwner, patch: ProjectPatch, commit: { action: 'memory' | 'context'; summary: string }): Promise<Applied> {
    const root = this.#path(project)!; const git = this.#git(project, commit.action === 'memory' ? 'memory-care' : 'context');
    try {
      return await this.#owned(project, owner, async workspace => {
        let base: string | null = null; let written = false;
        try {
          try { if (git) base = await workspace.prepare(); } catch (error) { await this.#release(workspace, 'unchanged'); return { status: 'refused', note: error instanceof Error ? error.message : 'The checkout is not clean.' }; }
          if (!this.#matches(root, patch, 'before')) { await this.#release(workspace, 'unchanged'); return { status: 'stale', note: 'The files changed since this change was computed. It was not applied over the newer text.' }; }
          const before = git ? await workspace.snapshot() : null;
          writeDocument(this.#journal(owner.conversationId), ApplyJournalSchema, { schema: 'improver-apply-journal-v1', projectId: project.id, patch });
          written = true; this.#write(root, patch, 'after');
          if (!git) { await this.#release(workspace, 'unchanged'); return { status: 'applied', commit: null, published: false }; }
          // Files Git ignores leave nothing to commit: the change is applied on this device only, with no commit to publish or revert.
          if (!(await workspace.checkpoint(commit.action, commit.summary, before!)).committed) { await this.#release(workspace, 'unchanged'); return { status: 'applied', commit: null, published: false }; }
          const ledger = new ConversationLedger(this.careHomes, owner.conversationId, { redactor: this.options.redactor });
          const publication = await publishWorkspace(workspace, ledger, this.careHomes, this.options.leases, { baseCommit: base!, nextStretch: () => 1, integrate: async () => false, signal: this.#abort.signal });
          if (publication.status === 'published') { await this.#release(workspace, 'published'); return { status: 'applied', commit: publication.commit, published: true }; }
          await this.#discardLocal(workspace, base!, 1); await this.#release(workspace, 'discarded');
          return { status: 'refused', note: publication.notice ?? 'Publication did not complete. Nothing was changed.' };
        } catch (error) {
          await this.#restore(workspace, root, patch, base, written).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof Busy) return { status: 'refused', note: error.message };
      throw error;
    }
  }
  /** Returns the checkout to its starting point after an interrupted apply, keeping a saved ref for any commit. */
  async #restore(workspace: GitWorkspace, root: string, patch: ProjectPatch, base: string | null, written: boolean): Promise<void> {
    if (written && (!base || await workspace.head() === base) && this.#matches(root, patch, 'after')) this.#write(root, patch, 'before');
    if (base && await workspace.head() !== base && await workspace.clean()) { await this.#discardLocal(workspace, base, 1); await this.#release(workspace, 'discarded'); return; }
    // Anything else keeps ownership: the checkout needs inspection before other work changes it.
    if (!base || await workspace.head() === base && await workspace.clean()) await this.#release(workspace, 'unchanged');
  }
  /**
   * Drops this operation's unpublished commits, keeping them under a saved ref. Publication may have rebased them onto
   * newer upstream work, so they are discarded back to that upstream, never past it into someone else's commits.
   */
  async #discardLocal(workspace: GitWorkspace, base: string, n: number): Promise<void> {
    if (await workspace.rebaseInProgress()) await workspace.abortRebase();
    const head = await workspace.head(); if (head === base) return;
    const upstream = await workspace.upstream();
    await workspace.discard(head !== upstream && await workspace.contains(upstream) ? upstream : base, head, n, () => undefined);
  }
  /** Only a commit that makes exactly this change, with the improver's own subject, may be reverted. */
  #ownCommit(root: string, commit: string, patch: ProjectPatch, action: 'memory' | 'context'): boolean {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
    try {
      const subject = git('show', '-s', '--format=%s', commit).trim(); const changed = git('diff', '--name-only', '--no-renames', '-z', `${commit}^`, commit, '--').split('\0').filter(Boolean).sort();
      return subject.startsWith(`${action}: `) && changed.join('\0') === patch.files.map(file => file.path).sort().join('\0');
    } catch { return false; }
  }
  /** Git projects revert the published commit and publish the revert; other projects restore the saved text if unchanged since. */
  async #undo(project: Project, owner: CheckoutOwner, applied: { commit: string | null; patch: ProjectPatch }, action: 'memory' | 'context'): Promise<{ commit: string | null }> {
    const root = this.#path(project)!;
    return this.#owned(project, owner, async workspace => {
      if (!applied.commit) {
        if (!this.#matches(root, applied.patch, 'after')) { await this.#release(workspace, 'unchanged'); throw new Error('The files changed since this was applied, so Undo would overwrite newer text.'); }
        this.#write(root, applied.patch, 'before'); await this.#release(workspace, 'unchanged'); return { commit: null };
      }
      let base: string;
      try { base = await workspace.prepare(); } catch (error) { await this.#release(workspace, 'unchanged'); throw error; }
      if (!this.#ownCommit(root, applied.commit, applied.patch, action)) { await this.#release(workspace, 'unchanged'); throw new Error('The recorded commit is not a change this suggestion made, so Undo will not revert it.'); }
      const parent = execFileSync('git', ['-C', root, 'rev-parse', `${applied.commit}^`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      try {
        const plan = await workspace.planUndo({ target: parent, sourceTip: applied.commit, step: 1, published: true });
        await workspace.applyUndo(plan, () => undefined, () => undefined);
      } catch (error) { if (await workspace.head() === base && await workspace.clean()) await this.#release(workspace, 'unchanged'); throw error; }
      const ledger = new ConversationLedger(this.careHomes, owner.conversationId, { redactor: this.options.redactor });
      const publication = await publishWorkspace(workspace, ledger, this.careHomes, this.options.leases, { baseCommit: base, nextStretch: () => 2, integrate: async () => false, signal: this.#abort.signal });
      if (publication.status === 'published') { await this.#release(workspace, 'published'); return { commit: publication.commit }; }
      await this.#discardLocal(workspace, base, 2); await this.#release(workspace, 'discarded');
      throw new Error(publication.notice ?? `Undo could not be published for ${action === 'memory' ? 'memory care' : 'this context change'}.`);
    });
  }

  async #result(task: ProjectTask, result: ProjectTaskResult): Promise<void> {
    await this.#device(ProjectTaskSchema, { schema: 'improver-device-request-v1', operation: 'task-result', taskId: task.id, result });
  }
  async #task(entry: ImproverDeviceWork['tasks'][number], project: Project | null): Promise<void> {
    const { task } = entry; const release = this.options.enterOperation(task.id, 'Applying an improver suggestion');
    try {
      if (!project || !this.#path(project)) throw new Error(`${project?.name ?? 'This project'} is not checked out on ${this.options.deviceName}.`);
      if (task.kind === 'undo-report') {
        const report = entry.report?.report; if (!report || report.status !== 'undoing') throw new Error('This memory care result is not waiting for Undo.');
        const undone = await this.#undo(project, this.#owner(task.id, 'Memory care undo'), report, 'memory');
        return await this.#result(task, { kind: 'undone', commit: undone.commit });
      }
      const suggestion = entry.suggestion?.suggestion; if (!suggestion) throw new Error('The suggestion is missing.');
      const action = suggestion.kind === 'memory-care' ? 'memory' as const : 'context' as const;
      if (task.kind === 'undo') {
        if (!suggestion.applied) throw new Error('This suggestion was not applied.');
        const undone = await this.#undo(project, this.#owner(task.id, 'Improver undo'), suggestion.applied, action);
        return await this.#result(task, { kind: 'undone', commit: undone.commit });
      }
      if (task.kind === 'apply') {
        const patch = entry.preview?.patch ?? suggestion.patch;
        const summary = suggestion.kind === 'memory-care' ? memoryCareCommit(suggestion.counts!) : (entry.preview?.title ?? suggestion.title);
        const applied = await this.#apply(project, this.#owner(task.id, suggestion.kind === 'memory-care' ? 'Memory care' : 'Context suggestion'), patch, { action, summary });
        if (applied.status === 'applied') return await this.#result(task, { kind: 'applied', commit: applied.commit, published: applied.published });
        if (applied.status === 'refused') return await this.#result(task, { kind: 'failed', note: applied.note });
        await this.#result(task, { kind: 'stale', note: applied.note });
      }
      // Recompute from the current files; a stale patch is never forced.
      const recomputed = suggestion.kind === 'memory-care'
        ? await this.#careProposal({ id: `${suggestion.id}_${task.id}` }, project, null, async () => undefined, [])
        : await this.#contextProposal(`${suggestion.id}_${task.id}`, project, suggestion.evidence.map(note => note.path), [], async () => undefined);
      if (typeof recomputed === 'string') return await this.#result(task, { kind: 'expired', note: `Recomputed from the current files: ${recomputed}` });
      const input = Array.isArray(recomputed) ? recomputed[0]! : this.#careSuggestion(suggestion.id, project, recomputed);
      await this.#result(task, { kind: 'recomputed', suggestion: { ...input, id: suggestion.id } });
    } catch (error) {
      await this.#result(task, { kind: 'failed', note: this.options.redactor.text(error instanceof Error ? error.message : 'The change could not be completed.').slice(0, 1200) }).catch(() => undefined);
    } finally { release(); }
  }
}
