import { LandingRouteSchema, MergeRouteSchema, type ProjectHub } from '../../packages/core/dist/index.js';

/** Recorded decisions for transport tests; no landing, merge or deploy is performed. */
export async function seedRouteDecision(hub: Pick<ProjectHub, 'putMergeDocument'>, identity: { projectId: string; threadId: string; deviceId: string; commit: string; at: string }, kind: 'landing' | 'merge') {
  const base = { ...identity, id: `route_${kind}_fixture`, revision: 0, route: kind === 'landing' ? 'land' : 'ask-owner', source: 'guard', state: 'waiting', reason: 'Recorded transport fixture.', calls: [] };
  const packet = { title: 'Transport fixture', task: { type: 'feature', goal: null, needs: [] }, summary: 'Simulated route context.', riskyAreas: '', files: [{ path: 'fixture.txt', bytes: 12, additions: 2, deletions: 1 }], corrections: [] };
  const document = kind === 'landing' ? LandingRouteSchema.parse({ schema: 'landing-route-v1', ...base, questionSet: 'l-v1', packet: { ...packet, schema: 'landing-route-state-v1', checks: [] } })
    : MergeRouteSchema.parse({ schema: 'merge-route-v1', ...base, questionSet: 'm-v1', prNumber: 1, failures: 0, decisionId: null, verificationId: null,
      packet: { ...packet, schema: 'merge-route-state-v1', totalSize: 3, files: packet.files.map(({ bytes: _bytes, ...file }) => { void _bytes; return file; }) } });
  return (await hub.putMergeDocument(document, 0)).document;
}
