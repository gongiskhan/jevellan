import { afterEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { buildJevRequest, JevClient, JevError, parseJevResponse, type JevQuestions, type JevRequest } from '../packages/decisions/dist/index.js';

const questions: JevQuestions = {
  next_action: { type: 'choice', instructions: 'What happens next?', criteria: { reply: 'Answer.', implement: 'Make the change.' } },
  memory_0: { type: 'score', instructions: 'How useful is Note: Vitest: use globals?', criteria: ['not useful', 'marginally useful', 'useful', 'essential'] },
  remember_request: { type: 'noul', instructions: 'The user explicitly asks to remember.', criteria: { true: 'Explicitly requested.', false: 'Not requested.' } },
};
const input: JevRequest = { schema: 'jev-request-v1', model: 'jev-configured', state: JSON.stringify({ conversation: { request: 'Add tests.' } }), questions };
const response = () => ({ model: 'jev-returned-version', usage: { input_tokens: 25, output_tokens: 12 }, answers: {
  next_action: { type: 'choice', choice: 'implement', probabilities: { reply: 0.1, implement: 0.9 }, confidence: 0.9 },
  memory_0: { type: 'score', score: 2.3, legend: { '0': 'not useful', '1': 'marginally useful', '2': 'useful', '3': 'essential' }, probabilities: { '0': 0.1, '1': 0, '2': 0.4, '3': 0.5 }, confidence: 0.8 },
  remember_request: { type: 'noul', noul: 0.85 },
} });
afterEach(() => vi.useRealTimers());

test('the real wire builder preserves JSON text, sends provider criteria and omits local versions', async () => {
  const wire = buildJevRequest(input);
  expect(wire).toEqual({ model: input.model, state: input.state, questions });
  expect(typeof wire.state).toBe('string');
  const secret = `fixture-${randomUUID()}`;
  const transport = vi.fn<typeof fetch>(async () => Response.json(response()));
  const client = new JevClient({ key: () => secret, timeoutMs: 4000, fetch: transport });
  const result = await client.decide(input);
  const [url, init] = transport.mock.calls[0]!;
  expect(url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
  expect(JSON.parse(String(init!.body))).toEqual(wire);
  expect(result).toEqual({ ...response(), schema: 'jev-response-v1' });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test.each([
  {},
  { only: { type: 'choice', instructions: 'Pick.', criteria: { one: 'Only one.' } } },
  { many: { type: 'choice', instructions: 'Pick.', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, n) => [`m${n}`, 'Model.'])) } },
  { few: { type: 'score', instructions: 'Rate.', criteria: ['one'] } },
  { many: { type: 'score', instructions: 'Rate.', criteria: Array.from({ length: 11 }, () => 'level') } },
  { 'invalid question id': questions.next_action },
])('invalid question sets never send a request: %#', async (invalid) => {
  const transport = vi.fn<typeof fetch>();
  const client = new JevClient({ key: () => 'fixture', timeoutMs: 4000, fetch: transport });
  await expect(client.decide({ ...input, questions: invalid as JevQuestions })).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(transport).not.toHaveBeenCalled();
});

test('fractional Score, zero-based levels and Noul without confidence survive unchanged', () => {
  const result = parseJevResponse(JSON.stringify(response()), questions);
  expect(result.answers.memory_0).toMatchObject({ score: 2.3, probabilities: { '0': 0.1, '3': 0.5 } });
  expect(result.answers.remember_request).toEqual({ type: 'noul', noul: 0.85 });
  expect(result.model).toBe('jev-returned-version');
  expect(result.usage).toEqual({ input_tokens: 25, output_tokens: 12 });
});

test.each([
  ['missing answer', (r: Record<string, unknown>) => { r.answers = {}; }],
  ['missing usage', (r: Record<string, unknown>) => { delete r.usage; }],
  ['missing returned model', (r: Record<string, unknown>) => { delete r.model; }],
  ['negative usage', (r: Record<string, unknown>) => { r.usage = { input_tokens: -1, output_tokens: 1 }; }],
  ['wrong type', (r: Record<string, unknown>) => { r.answers = { ...response().answers, next_action: { type: 'noul', noul: 0.8 } }; }],
])('rejects %s without inventing values', (_name, change) => {
  const body: Record<string, unknown> = response(); change(body);
  expect(() => parseJevResponse(JSON.stringify(body), questions)).toThrow(JevError);
});

test.each([
  { choice: 'unknown' },
  { confidence: undefined },
  { probabilities: { reply: 0.1, implement: 0.8, unknown: 0.1 } },
  { probabilities: { implement: 1 } },
  { probabilities: { reply: -0.1, implement: 1.1 } },
  { probabilities: { reply: 0.1, implement: 0.4 } },
  { probabilities: { reply: 0.9, implement: 0.1 } },
])('rejects malformed Choice distributions: %#', (change) => {
  const body = response(); Object.assign(body.answers.next_action, change);
  expect(() => parseJevResponse(JSON.stringify(body), questions)).toThrow('invalid response');
});

test.each([
  { score: 4 }, { score: -1 }, { score: Number.NaN },
  { probabilities: { '1': 0, '2': 0.5, '3': 0.5, '4': 0 } },
  { probabilities: { '0': 0, '1': 0, '2': 0, '3': 0 } },
  { legend: { '1': 'not useful', '2': 'marginal', '3': 'useful', '4': 'essential' } },
])('rejects malformed Score responses: %#', (change) => {
  const body = response(); Object.assign(body.answers.memory_0, change);
  expect(() => parseJevResponse(JSON.stringify(body), questions)).toThrow('invalid response');
});

test('accepts documented rounding, but never repairs JSON or includes unsolicited answers', () => {
  const body = response(); body.answers.next_action.probabilities = { reply: 0.50, implement: 0.49 };
  Object.assign(body.answers, { unrelated: { type: 'noul', noul: 0.9 } });
  const parsed = parseJevResponse(JSON.stringify(body), questions);
  expect(parsed.answers.next_action).toMatchObject({ choice: 'implement' });
  expect(parsed.answers.unrelated).toBeUndefined();
  expect(() => parseJevResponse('```json\n' + JSON.stringify(body) + '\n```', questions)).toThrow('invalid response');
});

test.each([429, 500, 529])('HTTP %s retries once after one second, preserving the actual request', async (status) => {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('ignored', { status })).mockResolvedValueOnce(Response.json(response()));
  const client = new JevClient({ key: () => 'fixture', timeoutMs: 4000, fetch: transport });
  const pending = client.decide(input);
  await vi.advanceTimersByTimeAsync(999); expect(transport).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); const result = await pending;
  expect(transport).toHaveBeenCalledTimes(2); expect(result.model).toBe('jev-returned-version');
  expect(transport.mock.calls[1]![1]!.body).toBe(transport.mock.calls[0]![1]!.body);
});

test.each([401, 403, 400, 422])('HTTP %s does not retry or expose the response body', async (status) => {
  const secret = `fixture-${randomUUID()}`;
  const transport = vi.fn<typeof fetch>(async () => new Response(secret, { status }));
  const client = new JevClient({ key: () => secret, timeoutMs: 4000, fetch: transport });
  const failure = await client.decide(input).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(JevError); expect(String(failure)).not.toContain(secret); expect(transport).toHaveBeenCalledTimes(1);
});

test('a second service failure terminates instead of retrying indefinitely', async () => {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>(async () => new Response('ignored', { status: 503 }));
  const pending = expect(new JevClient({ key: () => 'fixture', timeoutMs: 4000, fetch: transport }).decide(input)).rejects.toMatchObject({ kind: 'unavailable' });
  await vi.advanceTimersByTimeAsync(1000); await pending; expect(transport).toHaveBeenCalledTimes(2);
});

test('absent keys and vault errors fail closed without reading ambient credentials', async () => {
  const transport = vi.fn<typeof fetch>();
  for (const key of [() => undefined, () => { throw new Error('private vault detail'); }]) {
    await expect(new JevClient({ key, timeoutMs: 4000, fetch: transport }).decide(input)).rejects.toMatchObject({ kind: 'no-key', message: 'no key configured' });
  }
  expect(transport).not.toHaveBeenCalled();
});

test('caller cancellation stops the retry wait and prevents another request', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const transport = vi.fn<typeof fetch>(async () => new Response('ignored', { status: 429 }));
  const pending = expect(new JevClient({ key: () => 'fixture', timeoutMs: 4000, fetch: transport }).decide(input, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
  await vi.advanceTimersByTimeAsync(100); controller.abort(); await pending;
  await vi.advanceTimersByTimeAsync(1000); expect(transport).toHaveBeenCalledTimes(1);
});

test('connection test parses aliases without rejecting a configured version missing from the listing', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ models: [{ name: 'jev-latest', description: 'Current model.', release_date: '2026-09-22' }] }));
  const models = await new JevClient({ key: () => 'fixture', timeoutMs: 4000, fetch: transport }).models();
  expect(models).toMatchObject({ schema: 'jev-models-v1', models: [{ name: 'jev-latest' }] });
  expect(transport.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/models');
  expect(transport.mock.calls[0]![1]!.method).toBe('GET'); expect(transport.mock.calls[0]![1]!.body).toBeUndefined();
});

test('native fetch posts the validated payload and times out while reading an unfinished body', async () => {
  let requests = 0; let seen: unknown; const secret = `fixture-${randomUUID()}`;
  const server = createServer(async (request, reply) => {
    requests++; const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    seen = { path: request.url, authMatches: request.headers.authorization === `Bearer ${secret}`, body: JSON.parse(Buffer.concat(chunks).toString()) };
    reply.writeHead(200, { 'Content-Type': 'application/json' });
    if (requests === 1) reply.end(JSON.stringify(response())); else reply.write('{');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new JevClient({ key: () => secret, timeoutMs: 200, fetch: (url, init) => fetch(base + new URL(String(url)).pathname, init) });
  try {
    expect((await client.decide(input)).model).toBe('jev-returned-version');
    expect(seen).toEqual({ path: '/v1/systemone', authMatches: true, body: buildJevRequest(input) });
    await expect(client.decide(input)).rejects.toMatchObject({ kind: 'timeout' }); expect(requests).toBe(2);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
