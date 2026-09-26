import { ContextPanelSchema } from '@jevellan/core/client';
import { api } from './api.js';

function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, 500);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Project saves may still be finishing their owned instruction-file operation. */
export async function waitForProjectSetup(
  projectId: string,
  signal: AbortSignal,
  waiting: () => void,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const panel = await api(
      `/api/projects/${encodeURIComponent(projectId)}/context/operations`,
      ContextPanelSchema,
      'GET',
      undefined,
      { signal, waitForHub: true },
    );
    if (!panel.busy) {
      const unfinished = panel.operations.find(
        (operation) => !['completed', 'cancelled'].includes(operation.status),
      );
      if (unfinished)
        throw new Error(
          `Project setup needs attention. Open Context in Settings → Projects.${unfinished.reason ? ` ${unfinished.reason}` : ''}`,
        );
      return;
    }
    waiting();
    await pause(signal);
  }
}
