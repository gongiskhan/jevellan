import type { ProjectLedgerEvent } from '@jevellan/core/client';

/** Keep the initial replay off screen until it reaches the first work snapshot's ledger head. */
export function projectHistory() {
  const pending = new Map<number, ProjectLedgerEvent>();
  let head: number | undefined;
  let cursor = 0;
  const complete = () => {
    if (head === undefined || cursor < head) return;
    const snapshot = [...pending.values()].sort((a, b) => a.id - b.id); pending.clear();
    return snapshot;
  };
  return {
    add(event: ProjectLedgerEvent) {
      pending.set(event.id, event); cursor = Math.max(cursor, event.id);
      return complete();
    },
    snapshot(lastEventId: number) {
      // Polls may advance while replay is arriving; only the first snapshot defines this replay boundary.
      head ??= lastEventId;
      return complete();
    },
  };
}
