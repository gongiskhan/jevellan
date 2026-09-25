import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ContextOperationSchema, ContextPanelSchema, ContextViewSchema, type ContextOperation } from '@jevellan/core';
import { waitForProjectSetup } from '../apps/web/lib/project-setup.js';

const context = ContextViewSchema.parse({ schema: 'project-context-v1', projectId: 'fixture', state: 'none', fingerprint: 'a'.repeat(64), claudeReadsAgents: false,
  files: ['AGENTS.md', 'CLAUDE.md'].map(name => ({ name, kind: 'missing', tracked: false, hash: 'a'.repeat(64), content: '' })) });
const operation = (status: ContextOperation['status']) => ContextOperationSchema.parse({ schema: 'context-operation-v1', id: 'setup', projectId: 'fixture', conversationId: 'setup_conversation', workId: 'setup_work', createdAt: '2026-09-25T00:00:00.000Z',
  request: { schema: 'context-request-v1', clientRequestId: 'setup', revision: 1, fingerprint: context.fingerprint, choice: 'create' }, before: context, generation: 1, status });
const response = (busy: boolean, status?: ContextOperation['status']) => Response.json(ContextPanelSchema.parse({ schema: 'context-panel-v1', context, revision: 1, busy, operations: status ? [operation(status)] : [] }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('new conversation waits for instruction setup and its final ownership cleanup', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response(true, 'applying')).mockResolvedValueOnce(response(true, 'completed')).mockResolvedValueOnce(response(false, 'completed'));
  vi.stubGlobal('fetch', fetcher); const waiting = vi.fn(); const start = vi.fn();
  const pending = waitForProjectSetup('fixture', new AbortController().signal, waiting).then(start);
  await vi.advanceTimersByTimeAsync(0); expect(waiting).toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500); expect(start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500); await pending; expect(start).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.every(([path, options]) => path === '/api/projects/fixture/context/operations' && options.method === 'GET')).toBe(true);
});

test.each(['blocked', 'draft-ready', 'requested'] as const)('new conversation preserves unfinished %s context work for user attention', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(false, status)));
  await expect(waitForProjectSetup('fixture', new AbortController().signal, vi.fn())).rejects.toThrow('Open Context in Settings → Projects.');
});

test('leaving the composer abandons the setup wait without another request', async () => {
  const fetcher = vi.fn().mockImplementation(async () => response(true, 'applying')); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(); const pending = waitForProjectSetup('fixture', controller.signal, vi.fn());
  const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0); controller.abort(); await stopped;
  await vi.advanceTimersByTimeAsync(5_000); expect(fetcher).toHaveBeenCalledOnce();
});

test.each([undefined, 'cancelled'] as const)('projects without unfinished context work can start immediately (%s)', async status => {
  const fetcher = vi.fn().mockResolvedValue(response(false, status)); vi.stubGlobal('fetch', fetcher); const waiting = vi.fn();
  await waitForProjectSetup('fixture', new AbortController().signal, waiting); expect(waiting).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
});
