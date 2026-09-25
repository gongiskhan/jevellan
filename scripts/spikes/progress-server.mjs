import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';

const root = resolve(process.argv[2]); const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('An explicit unprivileged port is required');
const allowed = new Set(['index.html', 'report.css', 'report.js', 'run.json', 'conversation.png', 'changes.png', 'verification.png', 'why-manual.png', 'projects.png', 'rigging.png', 'phone.png', 'phase2-adoption-desktop-light.png', 'phase2-undo-desktop-light.png', 'phase5-first-run-why-desktop-dark.png', 'phase5-first-run-running-phone-light.png', 'phase5-guide-jev-phone-light.png', 'phase5-guide-conversation-desktop-dark.png']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1) || 'index.html';
  if (!['GET', 'HEAD'].includes(request.method) || !allowed.has(name)) { response.writeHead(404).end('Not found'); return; }
  try {
    const body = await readFile(join(root, name));
    response.writeHead(200, { 'Content-Type': types[extname(name)], 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Read-only progress report listening on 127.0.0.1:${port}`));
process.once('SIGTERM', () => server.close()); process.once('SIGINT', () => server.close());
