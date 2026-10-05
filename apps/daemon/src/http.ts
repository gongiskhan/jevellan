import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value));
}
function failure(message: string, status: number) { return Object.assign(new Error(message), { status }); }
export function requestBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return Promise.reject(failure('Send this request as JSON.', 415));
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') return Promise.reject(failure('Compressed request bodies are not supported.', 415));
  const limit = 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = []; let settled = false;
    const refuse = (error: Error) => { if (!settled) { settled = true; chunks.length = 0; reject(error); } };
    // A client that left while the handler awaited other work has already destroyed the request: its body never ends and
    // its 'aborted' and 'error' events have passed, so waiting would hold the request's lifecycle activity forever.
    if (request.destroyed) { refuse(failure('The request was interrupted.', 400)); return; }
    request.on('data', (chunk: Buffer) => {
      if (settled) return; size += chunk.length;
      if (size > limit) refuse(failure('This request is too large.', 413)); else chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); settled = true; resolve(value); }
      catch { refuse(failure('Invalid JSON request.', 400)); }
    });
    request.on('error', () => refuse(failure('The request was interrupted.', 400)));
    request.on('aborted', () => refuse(failure('The request was interrupted.', 400)));
    request.on('close', () => refuse(failure('The request was interrupted.', 400)));
  });
}
