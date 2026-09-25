/** Coalesce stream notifications without discarding a completed page read. */
export function queuedRefresh<T>(read: (signal: AbortSignal) => Promise<T>, receive: (value: T) => void, failed: (error: unknown) => void) {
  const controller = new AbortController();
  let running = false; let queued = false;
  const request = async () => {
    if (controller.signal.aborted) return;
    queued = true;
    if (running) return;
    running = true;
    try {
      while (queued && !controller.signal.aborted) {
        queued = false;
        try { const value = await read(controller.signal); if (!controller.signal.aborted) receive(value); }
        catch (error) { if (!controller.signal.aborted) failed(error); }
      }
    } finally { running = false; }
  };
  return { request, stop: () => controller.abort() };
}
