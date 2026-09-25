import { buildJevRequest, JevError, parseJevModels, parseJevResponse, type JevModels, type JevRequest, type JevResponse } from './contract.js';

const API = 'https://api.typesafe.ai/v1';
export interface JevClientOptions {
  key: () => string | undefined | Promise<string | undefined>;
  timeoutMs: number;
  fetch?: typeof fetch;
}

function retryDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new JevError('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 1000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export class JevClient {
  readonly #key: JevClientOptions['key'];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  constructor(options: JevClientOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new JevError('invalid-request');
    this.#key = options.key; this.#fetch = options.fetch ?? fetch; this.#timeoutMs = options.timeoutMs;
  }

  async decide(input: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    const request = buildJevRequest(input);
    return parseJevResponse(await this.#request('systemone', JSON.stringify(request), signal), request.questions);
  }

  async models(signal?: AbortSignal): Promise<JevModels> {
    return parseJevModels(await this.#request('models', undefined, signal));
  }

  async #request(path: 'systemone' | 'models', body: string | undefined, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new JevError('cancelled');
    let key: string | undefined;
    try { key = await this.#key(); } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 503) throw Object.assign(new Error('The credential source is unavailable. Retry when it reconnects.'), { status: 503 });
      throw new JevError('no-key');
    }
    if (!key?.trim()) throw new JevError('no-key');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new JevError('cancelled');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let retry = false;
      try {
        const response = await this.#fetch(`${API}/${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
          headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body }),
        });
        if (response.ok) return await response.text();
        const status = response.status;
        // Provider error bodies can echo inputs or authentication. They are never read or stored.
        await response.body?.cancel();
        retry = attempt === 0 && (status === 429 || status >= 500);
        if (!retry) throw new JevError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limited' : status >= 500 ? 'unavailable' : 'invalid-request');
      } catch (error) {
        if (signal?.aborted) throw new JevError('cancelled');
        if (controller.signal.aborted) throw new JevError('timeout');
        if (error instanceof JevError) throw error;
        throw new JevError('network');
      } finally { clearTimeout(timer); }
      if (retry) await retryDelay(signal);
    }
    throw new JevError('unavailable');
  }
}
