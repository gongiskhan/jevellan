import { ProjectShortIdsSchema, ShortIdSchema, type DocumentStore, type ProjectShortIds, type ShortIdPrefix } from '@jevellan/core';

const NAMESPACE = 'owner-short-ids';

/**
 * Short display ids (bridge specification, "Short ids"): counted per project and prefix on the state point, never reused. An object
 * keeps its id forever; objects that existed before the bridge get theirs the first time a view shows them, in creation order.
 */
export class OwnerShortIds {
  constructor(private readonly store: DocumentStore) {}
  #read(projectId: string): { document: ProjectShortIds; revision: number } {
    const stored = this.store.get(NAMESPACE, projectId, ProjectShortIdsSchema);
    return stored ? { document: stored.document, revision: stored.revision } : { document: { schema: 'project-short-ids-v1', projectId, next: {}, ids: {} }, revision: 0 };
  }
  /** The id of each object, assigning missing ones in the given order (callers pass creation order). */
  assign(projectId: string, prefix: ShortIdPrefix, internalIds: readonly string[]): Map<string, string> {
    if (prefix === 'C') return new Map(internalIds.map(id => [id, 'C']));
    const { document, revision } = this.#read(projectId); let changed = false;
    for (const internalId of internalIds) {
      if (document.ids[internalId]) continue;
      const next = document.next[prefix] ?? 1;
      document.ids[internalId] = ShortIdSchema.parse(`${prefix}${next}`); document.next[prefix] = next + 1; changed = true;
    }
    if (changed) this.store.put(NAMESPACE, projectId, ProjectShortIdsSchema, document, revision);
    return new Map(internalIds.map(id => [id, document.ids[id]!]));
  }
  one(projectId: string, prefix: ShortIdPrefix, internalId: string): string { return this.assign(projectId, prefix, [internalId]).get(internalId)!; }
  /** The internal id for a short id or an internal id; null when unknown. Case-insensitive for the short form. */
  resolve(projectId: string, token: string): { internalId: string; shortId: string } | null {
    const { document } = this.#read(projectId); const wanted = token.trim().toUpperCase();
    if (document.ids[token]) return { internalId: token, shortId: document.ids[token]! };
    for (const [internalId, shortId] of Object.entries(document.ids)) if (shortId === wanted) return { internalId, shortId };
    return null;
  }
  shortOf(projectId: string, internalId: string): string | undefined { return this.#read(projectId).document.ids[internalId]; }
}
