import { LIBRARY_HEADERS_REQUIRED, LIBRARY_THREAD_FORBIDDEN, LIBRARY_OPERATION_MISSING, LIBRARY_FILE_UNAVAILABLE, LIBRARY_HASH_FAILED } from '@jevellan/projects';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { IdSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { json } from './http.js';
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
/** Owner and authenticated device routes share the streaming implementation. */
export async function handleLibrary(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, ownerSession?: string, deviceId?: string): Promise<boolean> {
  const match = url.pathname.match(/^\/(?:api\/projects|hub\/mesh\/library)\/([A-Za-z0-9_-]+)(?:\/library)?(?:\/(.*))?$/u);
  if (!match || !(url.pathname.startsWith('/hub/mesh/library/') || /\/library(?:\/|$)/u.test(url.pathname))) return false;
  const projectId = IdSchema.parse(match[1]), tail = match[2] ?? '', method = request.method ?? 'GET';
  const owner = () => { if (!ownerSession) throw failure('Sign in to Jevellan.', 401); };
  if (!tail && method === 'GET') { json(response, await app.library.page(projectId, url.searchParams.get('after') ?? undefined)); return true; }
  const upload = tail.match(/^(uploads|outputs\/([A-Za-z0-9_-]+)|jobs\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+))\/(.+)$/u);
  if (upload && method === 'PUT') {
    const threadId = upload[2], jobRunId = upload[3], artifactId = upload[4];
    if (jobRunId) { const run = (await app.projectHub.jobRun(jobRunId))?.document; if (!deviceId || !run || run.projectId !== projectId || run.deviceId !== deviceId) throw failure('Only the executing device can upload job artifacts.', 403); }
    else if (!threadId) owner();
    else { const thread = (await app.projectHub.thread(threadId))?.document; if (!thread || thread.projectId !== projectId || deviceId && thread.ownerDeviceId !== deviceId) throw failure(LIBRARY_THREAD_FORBIDDEN, 403); }
    const length = request.headers['content-length'], mime = request.headers['content-type'];
    if (!length || !/^\d+$/u.test(length) || typeof mime !== 'string') throw failure(LIBRARY_HEADERS_REQUIRED);
    const note = request.headers['x-jevellan-library-note'];
    json(response, await app.library.upload(projectId, { name: decodeURIComponent(upload[5]!), mime, size: Number(length), source: jobRunId ? 'job' : threadId ? 'thread' : 'owner',
      ...(jobRunId ? { jobRunId, artifactId } : {}),
      ...(threadId ? { threadId } : {}), ...(typeof note === 'string' ? { note: decodeURIComponent(note) } : {}), ...(ownerSession ? { ownerSession } : {}) }, request)); return true;
  }
  const content = tail.match(/^([A-Za-z0-9_-]+)\/content$/u);
  if (content && method === 'GET') {
    const item = await app.library.item(projectId, content[1]!), { localPath } = await app.library.get(projectId, item.id);
    const file = await open(localPath, 'r').catch(() => { throw failure(LIBRARY_FILE_UNAVAILABLE, 404); });
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size !== item.size) throw failure(LIBRARY_HASH_FAILED, 502);
      response.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': item.size, 'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(item.name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" });
      await pipeline(file.createReadStream({ autoClose: false }), response);
    } catch (error) {
      if (!response.headersSent) throw error;
      // An interrupted stream cannot be replaced by a JSON error response.
      response.destroy();
    } finally { await file.close(); }
    return true;
  }
  if (/^[A-Za-z0-9_-]+$/u.test(tail) && method === 'DELETE') { owner(); await app.library.remove(projectId, tail, ownerSession); json(response, { schema: 'empty-request-v1' }); return true; }
  throw failure(LIBRARY_OPERATION_MISSING, 404);
}
