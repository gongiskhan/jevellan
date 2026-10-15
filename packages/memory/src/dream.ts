import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryDreamReportSchema, MemoryDreamStateSchema, MemoryDreamWatermarkSchema, newId, readDocument, writeDocument,
  type MemoryDreamReport, type MemoryDreamState, type MemoryProvenance, type Project } from '@jevellan/core';
import { HubMemoryStore, splitMemoryText } from './hub-store.js';

/** A dream edits a disposable copy; one local commit applies its checked diff. */
export class MemoryDream {
  constructor(readonly store: HubMemoryStore) {}
  file(projectId: string) { return join(this.store.root(projectId), 'dream.json'); }
  state(projectId: string): MemoryDreamState | null { return existsSync(this.file(projectId)) ? readDocument(this.file(projectId), MemoryDreamStateSchema) : null; }
  save(state: MemoryDreamState): MemoryDreamState { writeDocument(this.file(state.projectId), MemoryDreamStateSchema, state); return state; }
  watermark(projectId: string) { const file = join(this.store.root(projectId), 'dream-watermark.json'); return existsSync(file) ? readDocument(file, MemoryDreamWatermarkSchema).commit : null; }
  setWatermark(projectId: string, commit: string | null) { writeDocument(join(this.store.root(projectId), 'dream-watermark.json'), MemoryDreamWatermarkSchema, { schema: 'memory-dream-watermark-v1', projectId, commit }); }
  initialise(projectId: string, commit: string) { if (!this.watermark(projectId)) this.setWatermark(projectId, commit); }
  #stagingBase(state: MemoryDreamState) { return this.store.manager.homes.at('project-memory', state.projectId, 'dreams', state.id, 'notes'); }
  staging(state: MemoryDreamState) { return { id: state.id, path: this.store.staged(state.projectId, this.#stagingBase(state)) }; }
  baseline(state: MemoryDreamState) { return this.store.manager.homes.at('project-memory', state.projectId, 'dreams', state.id, 'baseline'); }
  begin(project: Project, mainCommit: string, provenance: MemoryProvenance, mode: 'apply' | 'suggest'): Promise<MemoryDreamState> {
    return this.store.exclusive(project.id, async () => {
      const prior = this.state(project.id); if (prior && ['running', 'suggested'].includes(prior.state)) throw new Error('This project already has a dream to finish or apply.');
      const root = this.store.ensure(project.id); if (this.store.dirty(root)) throw new Error('Memory has an unfinished write; retry the dream after it settles.');
      const state = MemoryDreamStateSchema.parse({ schema: 'memory-dream-state-v1', projectId: project.id, id: newId('dream'), mode, state: 'running',
        startedAt: this.store.at(), fromCommit: this.store.git(root, 'rev-parse', 'HEAD').trim(), mainCommit, previousMainCommit: this.watermark(project.id), report: null, diff: '', provenance });
      this.store.copyInto(project.id, this.#stagingBase(state)); cpSync(root, this.baseline(state), { recursive: true }); return this.save(state);
    });
  }
  #files(root: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (path: string, prefix = '') => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new Error('Dream notes must be regular files.');
        const ref = `${prefix}${entry.name}`;
        if (entry.isDirectory()) walk(join(path, entry.name), `${ref}/`); else if (/\.(?:md|markdown)$/iu.test(ref)) files.set(ref, readFileSync(join(path, entry.name), 'utf8'));
      }
    }; walk(root); return files;
  }
  #report(state: MemoryDreamState, before: Map<string, string>, after: Map<string, string>, summary: string, commit: string): MemoryDreamReport {
    const counts = { inboxPromoted: 0, inboxDropped: 0, merged: 0, corrected: 0, archived: 0, created: 0 }, changes: MemoryDreamReport['changes'] = [];
    const bodies = [...after].filter(([ref, value]) => !ref.startsWith('inbox/') && splitMemoryText(value).meta.status !== 'archived');
    for (const [ref, prior] of before) {
      const current = after.get(ref);
      if (!current) throw new Error('Dreams never delete notes; archive them with a reason.');
      if (splitMemoryText(prior).meta.source === 'owner' && prior !== current) throw new Error('A dream changed an owner note. Nothing was applied.');
    }
    for (const [ref, current] of after) {
      const prior = before.get(ref); if (prior === current) continue;
      const next = splitMemoryText(current), old = prior ? splitMemoryText(prior) : undefined;
      if (next.meta.title === 'Project brief' && next.body.length > 2000) throw new Error('Project brief must fit in 2,000 characters.');
      if (next.meta.status === 'archived' && old?.meta.status !== 'archived') {
        const reason = String(next.meta.archiveReason ?? '').trim(); if (!reason) throw new Error('Every archived note needs a reason.');
        // Promotions/merges require a surviving note that actually retained text or a link.
        const retained = bodies.some(([target, value]) => target !== ref && (value.includes(ref) || old && old.body.trim().length >= 20 && value.includes(old.body.trim().slice(0, 80))));
        if (ref.startsWith('inbox/')) { if (retained) counts.inboxPromoted++; else counts.inboxDropped++; changes.push({ note: ref, action: retained ? 'merged' : 'dropped', reason: reason.slice(0, 300) }); }
        else { if (retained) counts.merged++; else counts.archived++; changes.push({ note: ref, action: retained ? 'merged' : 'archived', reason: reason.slice(0, 300) }); }
      } else if (!prior) { counts.created++; changes.push({ note: ref, action: 'created', reason: 'A new durable note was added.' }); }
      else if (old!.body !== next.body) { counts.corrected++; changes.push({ note: ref, action: 'updated', reason: 'The note body changed in the dream commit.' }); }
    }
    return MemoryDreamReportSchema.parse({ schema: 'memory-dream-report-v1', projectId: state.projectId, dreamId: state.id, at: this.store.at(),
      fromCommit: state.fromCommit, toCommit: commit, mainCommit: state.mainCommit, counts, summary: this.store.manager.redactor.text(summary).slice(0, 1500),
      briefUpdated: [...after].some(([ref, value]) => splitMemoryText(value).meta.title === 'Project brief' && value !== before.get(ref)), changes: changes.slice(0, 200) });
  }
  finish(project: Project, summary: string): Promise<MemoryDreamState> {
    return this.store.exclusive(project.id, async () => {
      const state = this.state(project.id); if (!state || state.state !== 'running') throw new Error('There is no running dream to report.');
      const stage = this.staging(state).path;
      const before = this.#files(this.baseline(state)), after = this.#files(stage);
      this.#report(state, before, after, summary, state.fromCommit);
      const commit = this.store.commit(stage, `dream: ${this.store.at().slice(0, 10)}`);
      const diff = this.store.git(stage, 'diff', '--no-ext-diff', state.fromCommit, commit, '--', '.').slice(0, 999_950);
      const report = this.#report(state, before, after, summary, commit);
      let ready = this.save({ ...state, state: 'suggested', completedAt: this.store.at(), diff, report });
      if (ready.mode === 'apply') ready = await this.#apply(project, ready); return ready;
    });
  }
  async #apply(project: Project, state: MemoryDreamState): Promise<MemoryDreamState> {
    const root = this.store.ensure(project.id); let stage = state.applyId ? this.store.staged(project.id, this.store.manager.homes.at('project-memory', project.id, 'dreams', state.id, 'applications', state.applyId)) : this.staging(state).path, report = state.report!;
    const head = this.store.git(root, 'rev-parse', 'HEAD').trim();
    if (head === report.toCommit) { this.setWatermark(project.id, state.mainCommit); await this.store.project(project, { kind: 'viewer' }).sync(AbortSignal.timeout(150_000)); return this.save({ ...state, state: 'applied' }); }
    if (report.toCommit !== state.fromCommit) {
      let applied = false; try { this.store.git(root, 'merge-base', '--is-ancestor', report.toCommit, head); applied = true; } catch { /* The candidate has not reached the notes history. */ }
      if (applied) { this.setWatermark(project.id, state.mainCommit); await this.store.project(project, { kind: 'viewer' }).sync(AbortSignal.timeout(150_000)); return this.save({ ...state, state: 'applied' }); }
    }
    if (this.store.dirty(root)) throw new Error('Project memory has an unfinished write. Its files were preserved.');
    if (head !== state.fromCommit) {
      // Merge on a disposable copy. Concurrent notes stay available on the hub throughout.
      const applyId = newId('mapply'), candidate = this.store.copyInto(project.id, this.store.manager.homes.at('project-memory', project.id, 'dreams', state.id, 'applications', applyId));
      try {
        this.store.git(candidate, 'fetch', '--quiet', '--no-tags', this.store.top(stage), report.toCommit);
        this.store.git(candidate, 'merge', '--squash', '--no-commit', report.toCommit);
      } catch { throw new Error('Project memory changed since this suggestion and the same note conflicts. Start a new dream; all current notes were preserved.'); }
      const applied = this.store.commit(candidate, `dream: ${this.store.at().slice(0, 10)}`);
      state = { ...state, fromCommit: head, applyId }; stage = candidate;
      report = this.#report(state, this.#files(root), this.#files(stage), report.summary, applied);
      // Persist the exact candidate before activation, so a lost reply can settle the same commit.
      state = this.save({ ...state, report, diff: this.store.git(stage, 'diff', '--no-ext-diff', head, applied, '--', '.').slice(0, 999_950) });
    }
    this.#report(state, this.#files(root), this.#files(stage), report.summary, report.toCommit);
    // Fetch from the private staging copy only; no remote is added and no note is overwritten out of Git.
    this.store.git(root, 'fetch', '--quiet', '--no-tags', this.store.top(stage), report.toCommit);
    this.store.git(root, 'merge', '--ff-only', '--quiet', report.toCommit); this.store.changed(root);
    this.setWatermark(project.id, state.mainCommit);
    const saved = this.save({ ...state, state: 'applied', completedAt: this.store.at() });
    await this.store.project(project, { kind: 'viewer' }).sync(AbortSignal.timeout(150_000)); return saved;
  }
  apply(project: Project): Promise<MemoryDreamState> { return this.store.exclusive(project.id, async () => {
    const state = this.state(project.id); if (!state || !['suggested', 'applied'].includes(state.state)) throw new Error('There is no dream suggestion to apply.');
    return state.state === 'applied' ? state : this.#apply(project, state);
  }); }
  undo(project: Project): Promise<MemoryDreamState> { return this.store.exclusive(project.id, async () => {
    const state = this.state(project.id); if (state?.state === 'undone') return state;
    if (state?.state !== 'applied' || !state.report) throw new Error('There is no applied dream to undo.');
    const root = this.store.ensure(project.id); if (state.report.toCommit !== state.fromCommit) {
      try { this.store.git(root, 'revert', '--no-edit', state.report.toCommit); }
      catch { this.store.git(root, 'revert', '--abort'); throw new Error('Later memory changes conflict with Undo; they were preserved.'); }
    }
    this.store.changed(root);
    const saved = this.save({ ...state, state: 'undone', undoCommit: this.store.git(root, 'rev-parse', 'HEAD').trim() });
    this.setWatermark(project.id, state.previousMainCommit);
    await this.store.project(project, { kind: 'viewer' }).sync(AbortSignal.timeout(150_000)); return saved;
  }); }
  fail(projectId: string, reason: string): void {
    const state = this.state(projectId); if (state?.state === 'running') this.save({ ...state, state: 'failed', completedAt: this.store.at(), reason: this.store.manager.redactor.text(reason).slice(0, 1200) });
  }
  discard(projectId: string): void { const state = this.state(projectId); if (state?.state === 'suggested') { this.save({ ...state, state: 'failed', reason: 'The owner discarded this suggestion.' }); rmSync(this.staging(state).path, { recursive: true, force: true }); } }
}
