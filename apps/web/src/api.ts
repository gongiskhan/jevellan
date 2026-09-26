import {
  AccountListSchema,
  AuthStateSchema,
  ConfigRevisionSchema,
  DeviceRosterSchema,
  ErrorDocumentSchema,
  RiggingListSchema,
  RuntimeListSchema,
  SecretStateSchema,
  type DocumentSchema,
} from '@jevellan/core/client';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export const isCancelled = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const waits = new Map<AbortController, string>();
const listeners = new Set<() => void>();
let messages: readonly string[] = [];
function changed() {
  messages = [...new Set(waits.values())];
  for (const listener of listeners) listener();
}
export const hubWaiting = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: () => messages,
  stop() {
    for (const controller of waits.keys()) controller.abort();
  },
};
type RequestOptions = { signal?: AbortSignal | undefined; waitForHub?: boolean };
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
    }, 2000);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
export async function api<T>(
  path: string,
  schema: DocumentSchema<T>,
  method = 'GET',
  value?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const body = value === undefined ? undefined : JSON.stringify(value);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(path, {
          method,
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        controller.signal.throwIfAborted();
        throw new ApiError('Can’t reach Jevellan. Try again when it’s connected.', 0);
      }
      const result: unknown = await response.json().catch(() => null);
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const parsed = ErrorDocumentSchema.safeParse(result);
        const error = new ApiError(
          parsed.success ? parsed.data.message : 'The request could not complete.',
          response.status,
          parsed.success ? parsed.data.code : undefined,
          parsed.success && parsed.data.retryable === true,
        );
        if (
          options.waitForHub &&
          error.status === 503 &&
          error.code === 'hub-unavailable' &&
          error.retryable
        ) {
          waits.set(controller, error.message);
          changed();
          await pause(controller.signal);
          continue;
        }
        throw error;
      }
      try {
        return schema.parse(result);
      } catch {
        throw new ApiError('Jevellan returned an unexpected response. Reload this page.', 502);
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (waits.delete(controller)) changed();
  }
}
export const empty = { schema: 'empty-request-v1' };
export const authState = (signal?: AbortSignal) =>
  api('/api/auth', AuthStateSchema, 'GET', undefined, { signal, waitForHub: true });
export async function loadSettings(signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const read = <T>(path: string, schema: DocumentSchema<T>) =>
    api(path, schema, 'GET', undefined, { signal: controller.signal, waitForHub: true });
  try {
    const [config, accounts, runtimes, rigging, roster, jev] = await Promise.all([
      read('/hub/config', ConfigRevisionSchema),
      read('/hub/accounts', AccountListSchema),
      read('/api/runtimes', RuntimeListSchema),
      read('/hub/rigging', RiggingListSchema),
      read('/hub/devices/roster', DeviceRosterSchema),
      read('/hub/secrets/jev', SecretStateSchema),
    ]);
    return {
      config,
      accounts: accounts.accounts,
      runtimes: runtimes.runtimes,
      offered: runtimes.offered,
      rigging,
      roster,
      devices: { currentDeviceId: roster.currentDeviceId, devices: roster.devices.map((row) => row.device) },
      jev,
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
export type SettingsData = Awaited<ReturnType<typeof loadSettings>>;
