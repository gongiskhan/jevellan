import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { applicationRoot, DEFAULT_PORT, HealthSchema, VERSION } from '@jevellan/core';
import { Application, type ApplicationOptions } from './application.js';
import { handleApi } from './api.js';
import { closeListeners, detectTailscaleIpv4, listenOnInterfaces } from './network.js';
import { LocalDiagnostics } from './diagnostics.js';
import { handleLocalApi } from './local-api.js';
export * from './application.js';
export * from './routing-improver.js';
export * from './improver.js';
export * from './project-improver.js';
export { closeListeners, detectTailscaleIpv4, listenOnInterfaces } from './network.js';
export { projectWorkRoute, type ProjectWorkRoute, type ProjectWorkRouteName } from './project-work-api.js';

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

export function createDaemon(options: { application?: Application; diagnostics?: LocalDiagnostics; allowedOrigins?: readonly string[]; secureCookies?: boolean; proxyOrigin?: string } = {}) {
  const webRoot = join(applicationRoot(), 'apps', 'web', 'dist');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      // Local control (doctor, terminal takeover) is authorized by the installation control file, before any browser rule.
      if (url.pathname.startsWith('/api/local/')) { await handleLocalApi(options.application, options.diagnostics, request, response, url); return; }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(HealthSchema.parse({ schema: 'health-v1', status: 'ok', version: VERSION })));
        return;
      }
      if (options.application && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hub/') || url.pathname === '/switch')) {
        await handleApi(options.application, request, response, url, options); return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hub/') || request.method !== 'GET') {
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
      const data = await readFile(path).catch(async (error: unknown) => {
        if (!extname(requested) && (error as NodeJS.ErrnoException).code === 'ENOENT') return readFile(resolve(webRoot, 'index.html'));
        throw error;
      });
      response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] ?? (!extname(requested) ? contentTypes['.html']! : 'application/octet-stream'), 'Cache-Control': requested.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', ...(requested === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
      response.end(data);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  server.on('listening', () => {
    const address = server.address();
    if (options.application && address && typeof address !== 'string') options.application.bindDaemonUrl(`http://127.0.0.1:${address.port}`);
  });
  return server;
}

export async function startDaemon(port = DEFAULT_PORT, options: ApplicationOptions & { tailscaleAddress?: () => Promise<string | null> } = {}) {
  const tailscale = await (options.tailscaleAddress ?? detectTailscaleIpv4)();
  const serverOptions: Parameters<typeof createDaemon>[0] = { allowedOrigins: [] };
  const listeners = await listenOnInterfaces(() => createDaemon(serverOptions), port, tailscale);
  let application: Application | undefined;
  try {
    application = new Application({ ...options, port: listeners.port, url: options.url ?? listeners.addresses.at(-1)! });
    serverOptions.application = application;
    serverOptions.allowedOrigins = [...listeners.addresses, application.device.url];
    if (application.device.url.startsWith('https://')) serverOptions.proxyOrigin = application.device.url;
    application.bindDaemonUrl(listeners.addresses[0]!);
    serverOptions.diagnostics = new LocalDiagnostics(application, listeners.addresses[0]!);
  } catch (error) { await closeListeners(listeners.servers); await application?.close(); throw error; }
  const runningApplication = application;
  let closing: Promise<void> | undefined;
  return { ...listeners, application: runningApplication, close: () => closing ??= (async () => { await closeListeners(listeners.servers); try { serverOptions.diagnostics?.close(); } finally { await runningApplication.close(); } })() };
}
