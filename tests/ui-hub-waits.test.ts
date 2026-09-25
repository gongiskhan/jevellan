import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { api, hubWaiting } from '../apps/web/lib/api.js';

const resultSchema = z.strictObject({ schema: z.literal('fixture-result-v1'), revision: z.number() });
const result = { schema: 'fixture-result-v1', revision: 2 };
const notice = "Can't reach the hub (Fixture hub). This will continue when it's back.";
const outage = { schema: 'error-v1', code: 'hub-unavailable', message: notice, retryable: true };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { hubWaiting.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('browser waits with the exact hub notice and repeats only its captured request', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(outage, { status: 503 })).mockResolvedValueOnce(Response.json(result)); vi.stubGlobal('fetch', fetcher);
  const submitted = { schema: 'fixture-input-v1', clientRequestId: 'save_1', setting: 'original' };
  const pending = api('/hub/config', resultSchema, 'PUT', submitted, { waitForHub: true });
  await vi.advanceTimersByTimeAsync(0); expect(hubWaiting.snapshot()).toEqual([notice]);
  submitted.setting = 'later form edit'; await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual(result); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({ clientRequestId: 'save_1', setting: 'original' });
  expect(hubWaiting.snapshot()).toEqual([]);
});

test.each([
  { name: 'unreceipted mutation', body: { ...outage, retryable: false }, status: 503 },
  { name: 'untyped unavailable', body: { ...outage, code: 'request-failed' }, status: 503 },
  { name: 'rejected credentials', body: outage, status: 401 },
  { name: 'old error document', body: { schema: 'error-v1', code: 'hub-unavailable', message: notice }, status: 503 },
])('browser never automatically repeats $name', async ({ body, status }) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(body, { status })); vi.stubGlobal('fetch', fetcher);
  await expect(api('/mutation', resultSchema, 'POST', {}, { waitForHub: true })).rejects.toMatchObject({ status });
  await vi.advanceTimersByTimeAsync(4000); expect(fetcher).toHaveBeenCalledTimes(1); expect(hubWaiting.snapshot()).toEqual([]);
});

test('browser connection loss leaves the mutation outcome unknown without repeating it', async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')); vi.stubGlobal('fetch', fetcher);
  await expect(api('/hub/config', resultSchema, 'PUT', {}, { waitForHub: true })).rejects.toMatchObject({ status: 0 });
  await vi.advanceTimersByTimeAsync(4000); expect(fetcher).toHaveBeenCalledTimes(1); expect(hubWaiting.snapshot()).toEqual([]);
});

test.each(['navigation', 'stop waiting'])('browser %s abandons the pending retry without another write', async reason => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(outage, { status: 503 })); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(); const pending = api('/mutation', resultSchema, 'POST', {}, { waitForHub: true, signal: controller.signal });
  const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0); expect(hubWaiting.snapshot()).toEqual([notice]);
  if (reason === 'navigation') controller.abort(); else hubWaiting.stop();
  await stopped; await vi.advanceTimersByTimeAsync(4000); expect(fetcher).toHaveBeenCalledTimes(1); expect(hubWaiting.snapshot()).toEqual([]);
});

test('a mutation must opt into waiting even when its server response permits a retry', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(outage, { status: 503 })); vi.stubGlobal('fetch', fetcher);
  await expect(api('/mutation', resultSchema, 'POST', {})).rejects.toMatchObject({ status: 503, retryable: true });
  expect(hubWaiting.snapshot()).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(1);
});
