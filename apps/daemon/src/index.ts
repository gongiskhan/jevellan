import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { DEFAULT_PORT, HealthSchema, VERSION } from '@jevellan/core';

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createDaemon() {
  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/health' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(HealthSchema.parse({ schema: 'health-v1', status: 'ok', version: VERSION })));
        return;
      }
      if (url.pathname.startsWith('/api/') || request.method !== 'GET') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const requested = decodeURIComponent(url.pathname);
      const path = resolve(webRoot, `.${requested === '/' ? '/index.html' : requested}`);
      if (!path.startsWith(resolve(webRoot) + sep)) {
        response.writeHead(404).end();
        return;
      }
      const data = await readFile(path);
      response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      response.end(data);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
}

export async function startDaemon(port = DEFAULT_PORT) {
  const server = createDaemon();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
