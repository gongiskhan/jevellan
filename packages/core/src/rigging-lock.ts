const pending = new Map<string, Promise<unknown>>();

/** Delivery and explicit local edits share the same account-home queue. */
export async function withRiggingHome<T>(home: string, operation: () => T | Promise<T>): Promise<T> {
  const task = (pending.get(home) ?? Promise.resolve()).catch(() => undefined).then(operation);
  pending.set(home, task);
  try { return await task; } finally { if (pending.get(home) === task) pending.delete(home); }
}
