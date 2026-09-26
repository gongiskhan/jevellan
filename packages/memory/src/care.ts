import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import {
  MemoryCareCandidatesSchema, MemoryCareCountsSchema, MemoryPatchDraftSchema, ProjectPatchSchema, stableJson, unifiedDiff,
  type MemoryCareCandidates, type MemoryCareCounts, type MemoryNoteRef, type ProjectPatch, type ProjectPatchFile,
} from '@jevellan/core';

export const STALE_AFTER_MS = 90 * 86400_000;
const MAX_PAIRS = 40; const MAX_STALE = 40; const MAX_NOTE_BYTES = 256_000;

export type MemoryFile = {
  /** Project-relative path, as used in patches. */ path: string;
  /** Memory-folder-relative path, as the note is referenced. */ relative: string;
  content: string; title: string; permalink: string; unresolved: boolean; mergedFrom: boolean; links: string[]; modifiedAt: number; archived: boolean;
};
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const normalise = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function frontmatter(content: string): Record<string, unknown> {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  const document = parseDocument(match[1]!);
  return !document.errors.length && isMap(document.contents) ? document.toJS() as Record<string, unknown> : {};
}
function noteLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]*)?(?:\|[^\]\r\n]*)?\]\]/g)) links.add(match[1]!.trim());
  for (const match of content.matchAll(/\]\(([^)\s#]+\.(?:md|markdown))(?:#[^)\s]*)?\)/gi)) if (!/^[a-z][a-z0-9+.-]*:/i.test(match[1]!)) links.add(match[1]!);
  return [...links].filter(Boolean);
}
function lastCommitTimes(root: string, dir: string): Map<string, number> {
  const times = new Map<string, number>();
  try {
    const output = execFileSync('git', ['-C', root, 'log', '--format=@%ct', '--name-only', '--no-renames', '--', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
    let time = 0;
    for (const line of output.split('\n')) {
      if (line.startsWith('@')) time = Number(line.slice(1)) * 1000;
      else if (line && !times.has(line)) times.set(line, time);
    }
  } catch { /* Not a Git checkout, or no history yet: file times are used instead. */ }
  return times;
}

/** Reads regular Markdown notes; links, symlinks and oversized files are refused rather than followed. */
export function readMemoryFiles(root: string, memoryDir: string): MemoryFile[] {
  const base = join(root, memoryDir); if (!existsSync(base)) return [];
  const commits = lastCommitTimes(root, memoryDir); const files: MemoryFile[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name; const file = join(directory, entry.name); const info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('Project memory cannot contain links to other files.');
      if (info.isDirectory()) { if (!entry.name.startsWith('.')) visit(file, `${relative}/`); continue; }
      if (!info.isFile() || !/\.(?:md|markdown)$/i.test(entry.name)) continue;
      if (info.size > MAX_NOTE_BYTES) continue;
      const content = readFileSync(file, 'utf8'); const meta = frontmatter(content);
      const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : entry.name.replace(/\.(?:md|markdown)$/i, '');
      const permalink = typeof meta.permalink === 'string' && meta.permalink.trim() ? meta.permalink.trim() : relative;
      const path = posix.join(memoryDir, relative);
      files.push({ path, relative, content, title, permalink, unresolved: meta.status === 'unresolved', mergedFrom: /^## Merged from /m.test(content),
        links: noteLinks(content), modifiedAt: commits.get(path) ?? info.mtimeMs, archived: relative.split('/')[0] === 'archive' });
    }
  };
  visit(base, ''); return files;
}
export function noteRef(file: MemoryFile): MemoryNoteRef { return { path: file.path, permalink: file.permalink, title: file.title.slice(0, 300) }; }
function resolveLink(from: MemoryFile, link: string, files: MemoryFile[]): MemoryFile | null | 'outside' {
  if (/\.(?:md|markdown)$/i.test(link) && (link.includes('/') || link.startsWith('.'))) {
    const target = posix.normalize(posix.join(posix.dirname(from.relative), link));
    if (target.startsWith('../')) return 'outside';
    return files.find(file => file.relative === target) ?? null;
  }
  const key = normalise(link.replace(/\.(?:md|markdown)$/i, ''));
  return files.find(file => normalise(file.title) === key || normalise(file.permalink) === key || normalise(file.relative.replace(/\.(?:md|markdown)$/i, '')) === key) ?? null;
}
function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 8 || Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.1) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]! / Math.max(a.length, b.length) <= 0.1;
}

/**
 * Candidate collection is mechanical; Jev decides what the candidates mean.
 * Pairs are considered only when a note changed since the previous run (all notes on a first run).
 */
export function collectMemoryCandidates(files: MemoryFile[], options: { changed: Set<string> | null; now: number; searchPairs?: Array<[string, string]> }): MemoryCareCandidates {
  const live = files.filter(file => !file.archived);
  const changed = options.changed ? live.filter(file => options.changed!.has(file.path)) : live;
  const touched = (file: MemoryFile) => !options.changed || options.changed.has(file.path);
  const pairs: MemoryCareCandidates['pairs'] = []; const seen = new Set<string>();
  const add = (a: MemoryFile, b: MemoryFile, basis: 'title' | 'search') => {
    const [first, second] = [a.path, b.path].sort() as [string, string]; const key = `${first}\0${second}`;
    if (first === second || seen.has(key) || pairs.length >= MAX_PAIRS) return;
    seen.add(key); pairs.push({ a: first, b: second, basis });
  };
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i]!; const b = live[j]!;
    if ((touched(a) || touched(b)) && similar(normalise(a.title), normalise(b.title))) add(a, b, 'title');
  }
  for (const [a, b] of options.searchPairs ?? []) {
    const first = live.find(file => file.path === a); const second = live.find(file => file.path === b);
    if (first && second && (touched(first) || touched(second))) add(first, second, 'search');
  }
  const inbound = new Set<string>(); const brokenLinks: MemoryCareCandidates['brokenLinks'] = [];
  for (const file of live) for (const link of file.links) {
    const target = resolveLink(file, link, files);
    if (target === null) brokenLinks.push({ path: file.path, target: link.slice(0, 500) });
    else if (target !== 'outside' && target.path !== file.path) inbound.add(target.path);
  }
  const stale = live.filter(file => file.modifiedAt < options.now - STALE_AFTER_MS && !inbound.has(file.path) && !file.unresolved && !file.mergedFrom)
    .slice(0, MAX_STALE).map(file => file.path);
  return MemoryCareCandidatesSchema.parse({ schema: 'memory-care-candidates-v1', notes: live.map(noteRef), changed: changed.map(file => file.path),
    unresolved: live.filter(file => file.unresolved || file.mergedFrom).map(file => file.path), pairs, stale, brokenLinks: brokenLinks.slice(0, 200) });
}
/** Mutual top-five search hits count as strong overlap. */
export function searchOverlapPairs(results: Map<string, string[]>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [a, hits] of results) for (const b of hits.slice(0, 5)) if (a < b && results.get(b)?.slice(0, 5).includes(a)) pairs.push([a, b]);
  return pairs;
}

export type ConfirmedCare = { pairs: Array<[string, string]>; stale: string[]; unresolved: string[]; brokenLinks: MemoryCareCandidates['brokenLinks'] };
/** A stable key over the confirmed work and the exact note contents; unchanged dismissed work is not suggested again. */
export function careKey(kind: 'memory-care' | 'context', files: MemoryFile[], paths: string[]): string {
  const involved = [...new Set(paths)].sort().map(path => ({ path, content: sha256(files.find(file => file.path === path)?.content ?? '') }));
  return sha256(stableJson({ kind, involved }));
}
export function careInvolved(confirmed: ConfirmedCare): string[] {
  return [...new Set([...confirmed.pairs.flat(), ...confirmed.stale, ...confirmed.unresolved, ...confirmed.brokenLinks.map(link => link.path)])].sort();
}
export function patchFile(path: string, beforeText: string | null, after: string | null): ProjectPatchFile {
  return { path, before: beforeText === null ? null : sha256(beforeText), beforeText, after };
}
export function patchDiff(files: ProjectPatchFile[]): string { return files.map(file => unifiedDiff(file.path, file.beforeText, file.after)).join(''); }
export function projectPatch(files: ProjectPatchFile[]): ProjectPatch {
  return ProjectPatchSchema.parse({ schema: 'project-patch-v1', files, diff: patchDiff(files).slice(0, 1_000_000) });
}
const unresolvedStatus = (content: string) => frontmatter(content).status === 'unresolved' || /^## Merged from /m.test(content);

/**
 * Stale notes move into archive/ in code, never deleted. The draft may only merge
 * confirmed pairs, reconcile unresolved notes and fix links in notes involved in them.
 */
export function memoryCarePatch(memoryDir: string, files: MemoryFile[], confirmed: ConfirmedCare, raw: unknown): { patch: ProjectPatch | null; counts: MemoryCareCounts } {
  const draft = MemoryPatchDraftSchema.parse(raw);
  const byRelative = new Map(files.map(file => [file.relative, file]));
  const involved = new Set(careInvolved(confirmed));
  const linkers = new Set(files.filter(file => file.links.some(link => { const target = resolveLink(file, link, files); return target && target !== 'outside' && involved.has(target.path); })).map(file => file.path));
  const removable = new Set(confirmed.pairs.flat());
  const changes = new Map<string, ProjectPatchFile>();
  for (const entry of draft.files) {
    const relative = posix.normalize(entry.path);
    if (relative.startsWith('../') || relative.startsWith('/') || relative.split('/').some(part => part === '.git' || part.startsWith('.')) || !/\.(?:md|markdown)$/i.test(relative)) throw new Error('A memory patch may only change Markdown notes inside the memory folder.');
    if (relative.split('/')[0] === 'archive') throw new Error('Archiving is done by Jevellan, not by the draft.');
    const existing = byRelative.get(relative); const path = posix.join(memoryDir, relative);
    if (!existing) throw new Error('A memory patch cannot create new notes.');
    if (entry.content === existing.content) continue;
    if (entry.content === null ? !removable.has(path) : !involved.has(path) && !linkers.has(path)) throw new Error('A memory patch may only change notes that Jev confirmed or notes that link to them.');
    if (confirmed.stale.includes(path)) throw new Error('Stale notes are archived unchanged.');
    changes.set(path, patchFile(path, existing.content, entry.content));
  }
  for (const [a, b] of confirmed.pairs) if (changes.get(a)?.after === null && changes.get(b)?.after === null) throw new Error('A merge must keep one note of each pair.');
  const archived: string[] = [];
  for (const path of confirmed.stale) {
    const file = files.find(entry => entry.path === path); if (!file || changes.has(path)) continue;
    let target = posix.join('archive', file.relative); let suffix = 2;
    while (byRelative.has(target) || changes.has(posix.join(memoryDir, target))) target = posix.join('archive', posix.dirname(file.relative), `${posix.basename(file.relative).replace(/(\.[^.]+)$/, '')}-${suffix++}${posix.extname(file.relative)}`);
    changes.set(path, patchFile(path, file.content, null)); changes.set(posix.join(memoryDir, target), patchFile(posix.join(memoryDir, target), null, file.content));
    archived.push(path);
  }
  const after = (path: string) => changes.has(path) ? changes.get(path)!.after : files.find(file => file.path === path)?.content ?? null;
  const counts = MemoryCareCountsSchema.parse({
    merged: [...removable].filter(path => changes.get(path)?.after === null).length, archived: archived.length,
    fixedLinks: confirmed.brokenLinks.filter(link => { const content = after(link.path); return content !== null && changes.has(link.path) && !noteLinks(content).includes(link.target); }).length,
    reconciled: confirmed.unresolved.filter(path => { const content = after(path); return content !== null && changes.has(path) && !unresolvedStatus(content); }).length,
  });
  const ordered = [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { patch: ordered.length ? projectPatch(ordered) : null, counts };
}
export function memoryCareResult(counts: MemoryCareCounts): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `Merged ${plural(counts.merged, 'note', 'notes')}, archived ${counts.archived}, fixed ${plural(counts.fixedLinks, 'link', 'links')}${counts.reconciled ? `, reconciled ${counts.reconciled}` : ''}`;
}
export function memoryCareCommit(counts: MemoryCareCounts): string {
  return `nightly care (${counts.merged} merged, ${counts.archived} archived, ${counts.fixedLinks} links)`;
}
