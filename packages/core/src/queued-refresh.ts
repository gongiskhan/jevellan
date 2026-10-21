/** Serialize snapshot reads; an authoritative push supersedes an older in-flight fallback. */
export function queuedRefresh<T>(
  read: (signal: AbortSignal) => Promise<T>,
  receive: (value: T) => void,
  failed: (error: unknown) => void,
) {
  const controller = new AbortController();
  let running = false;
  let queued = false;
  let pushed = 0;
  const request = async () => {
    if (controller.signal.aborted) return;
    queued = true;
    if (running) return;
    running = true;
    try {
      while (queued && !controller.signal.aborted) {
        queued = false;
        try {
          const before = pushed;
          const value = await read(controller.signal);
          if (!controller.signal.aborted && pushed === before) receive(value);
        } catch (error) {
          if (!controller.signal.aborted) failed(error);
        }
      }
    } finally {
      running = false;
    }
  };
  return { request, push: (value: T) => { if (!controller.signal.aborted) { pushed++; receive(value); } }, stop: () => controller.abort() };
}
