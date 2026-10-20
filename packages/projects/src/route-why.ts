import { ProjectRouteWhyViewSchema, newId, routeWhyPollPolicy, type MergeDocument, type ProjectRouteWhyView } from '@jevellan/core';

type Context = { projectId: string; threadId: string; records: readonly MergeDocument[]; saved?: boolean };
type Input = Context & ({ kind: 'landing' } | { kind: 'merge'; commit: string; automatic: boolean });
const mergeLabels = { merge: 'Merge', 'test-then-merge': 'Test then merge', 'ask-owner': 'Ask owner' } as const;
const shadowLabels = { merge: 'merge', 'test-then-merge': 'test then merge', 'ask-owner': 'ask you' } as const;
export function routeWhyView(input: Input): ProjectRouteWhyView {
  const route = input.kind === 'landing' ? input.records.filter(row => row.schema === 'landing-route-v1').sort((a, b) => b.at.localeCompare(a.at))[0]
    : input.records.find(row => row.schema === 'merge-route-v1' && row.commit === input.commit);
  const selected = route?.schema === 'landing-route-v1' || route?.schema === 'merge-route-v1' ? route : null;
  const commit = input.kind === 'merge' ? input.commit : selected?.commit ?? null, path = `/api/projects/${input.projectId}/threads/${input.threadId}/${input.kind === 'landing' ? 'landing' : 'pr'}`;
  return ProjectRouteWhyViewSchema.parse({ schema: 'project-route-why-view-v1', projectId: input.projectId, threadId: input.threadId, kind: input.kind, commit,
    title: input.kind === 'landing' ? 'Why this landing' : 'Why this merge route', emptyText: input.kind === 'landing' ? 'No landing route recorded yet.' : 'No merge route has been recorded at this commit.',
    pollHintMs: input.kind === 'merge' ? routeWhyPollPolicy.mergeMs : null,
    shadowLine: input.kind === 'merge' && !input.automatic && selected?.schema === 'merge-route-v1' ? `Jev would: ${shadowLabels[selected.route]}` : null,
    savedNotice: input.saved ? `Saved for future ${input.kind} decisions.` : null,
    route: selected ? { id: selected.id, routeLabel: selected.schema === 'merge-route-v1' ? mergeLabels[selected.route] : selected.route,
      sourceLabel: selected.schema === 'merge-route-v1' ? selected.source === 'jev' ? 'Jev' : 'Guard' : selected.source, stateLabel: selected.state,
      reason: selected.reason ?? null, checkedCommit: selected.schema === 'landing-route-v1' ? selected.checkedCommit ?? selected.commit : selected.commit,
      changeLine: selected.schema === 'merge-route-v1' ? `${selected.packet.totalSize} added and removed lines across ${selected.packet.files.length} files.` : null,
      riskyLine: `Risky areas: ${selected.packet.riskyAreas || 'None specified.'}`, summary: selected.packet.summary,
      checks: selected.schema === 'landing-route-v1' ? selected.packet.checks.map(check => ({ name: check.name, resultLabel: check.passed ? 'passed' : 'failed' })) : [],
      files: selected.schema === 'landing-route-v1' ? selected.packet.files.map(file => ({ path: file.path, detail: `${file.bytes} bytes, +${file.additions} −${file.deletions}` }))
        : selected.packet.files.map(file => ({ path: file.path, detail: `+${file.additions} −${file.deletions}` })),
      probabilities: selected.schema === 'merge-route-v1' ? Object.entries(selected.probabilities ?? {}).map(([name, p]) => `${name}: ${Math.round(p * 100)}%`) : [], corrections: selected.packet.corrections } : null,
    verifications: input.kind === 'merge' && selected?.schema === 'merge-route-v1' ? input.records.flatMap(row => row.schema === 'verification-run-v1' && row.commit === input.commit ? [{ id: row.id,
      summary: `Basic verification: ${row.state} · ${row.modelLabel} · ${row.providerChoice.replaceAll('-', ' ')}`, note: row.note ?? '', commands: row.report?.commands ?? [], failures: row.report?.failures ?? [] }] : []) : [],
    correctionActions: selected ? (['should-have-asked', 'did-not-need-asking'] as const).map(correction => ({ id: correction, label: correction === 'should-have-asked' ? 'Should have asked me' : "Didn't need asking",
      request: { path: `${path}/why-correction`, body: { schema: input.kind === 'landing' ? 'landing-correction-input-v1' : 'merge-correction-input-v1', clientRequestId: newId('route_correction'), commit: selected.commit, correction } } })) : [],
  });
}
