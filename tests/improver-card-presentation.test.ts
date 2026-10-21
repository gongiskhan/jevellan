import { expect, test } from 'vitest';
import { ProjectSuggestionRowSchema } from '../packages/core/dist/index.js';
import { patchFile, projectPatch } from '../packages/memory/dist/index.js';
import { projectCard } from '../apps/daemon/dist/improver-cards.js';

test('engine improver projection supplies note evidence actions and singular/plural copy', () => {
  const now = '2026-10-21T00:00:00.000Z';
  const row = ProjectSuggestionRowSchema.parse({ schema: 'project-suggestion-row-v1', revision: 1, suggestion: {
    schema: 'project-suggestion-v1', id: 'suggestion_notes', kind: 'context', projectId: 'project', projectName: 'Fixture', deviceId: 'hub', jobId: 'job_fixture', title: 'A context proposal', reason: 'Recorded note evidence.',
    evidence: [{ path: 'notes/first.md', permalink: 'notes/first', title: 'First note' }, { path: 'notes/second.md', permalink: 'notes/second', title: 'Second note' }],
    counts: null, patch: projectPatch([patchFile('AGENTS.md', 'Before\n', 'After\n')]), suppressionKey: 'a'.repeat(64), status: 'pending', error: null, outcomes: [], applied: null, createdAt: now, updatedAt: now,
  } });
  const before = structuredClone(row), card = projectCard(row, Date.parse(now));
  expect(card).toMatchObject({ presentation: { schema: 'improver-card-presentation-v1', evidence: { summary: 'Based on 2 notes', entries: [
    { id: 'notes/first', at: null, label: 'First note', detail: 'notes/first.md', action: { kind: 'note', permalink: 'notes/first' } },
    { id: 'notes/second', at: null, label: 'Second note', detail: 'notes/second.md', action: { kind: 'note', permalink: 'notes/second' } },
  ] }, check: null } });
  const singular = projectCard({ ...row, suggestion: { ...row.suggestion, evidence: row.suggestion.evidence.slice(0, 1) } }, Date.parse(now));
  expect(singular).toMatchObject({ presentation: { evidence: { summary: 'Based on 1 note' } } }); expect(row).toEqual(before);
});
