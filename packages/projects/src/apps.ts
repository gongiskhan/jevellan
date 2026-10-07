import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { NativeProcessSchema, ProjectAppInputSchema, ProjectAppSchema, readDocument, spawnGroup, terminateGroup, writeDocument,
  type Homes, type NativeProcess, type ProjectApp, type SecretRedactor } from '@jevellan/core';

export type AppInput = z.infer<typeof ProjectAppInputSchema>;
export type AppScope = { projectId: string; threadId: string; cwd: string; projectDirectory: string };
type Link = Pick<ProjectApp, 'url' | 'access' | 'httpsPort'>;
export type AppPublisher = { publish(port: number): Promise<Link>; remove(app: ProjectApp): Promise<void> };
const run = promisify(execFile);
const ServeSchema = z.object({ TCP: z.record(z.string(), z.unknown()).optional(), Web: z.record(z.string(), z.object({
  Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() }).passthrough()) })).optional() }).passthrough();

/** Dedicated origins preserve root asset URLs and never replace an existing Tailscale route. */
export function tailnetAppPublisher(origin: () => Promise<string>, execute: (args: string[]) => Promise<string> = async args =>
  (await run('tailscale', args, { timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout): AppPublisher {
  const status = async () => ServeSchema.parse(JSON.parse(await execute(['serve', 'status', '--json'])));
  return {
    async publish(port) {
      const base = new URL(await origin());
      if (!base.hostname.endsWith('.ts.net')) return { access: 'local', url: `http://127.0.0.1:${port}/` };
      const before = await status(); let httpsPort = 9600;
      while (before.TCP?.[String(httpsPort)] || before.Web?.[`${base.hostname}:${httpsPort}`]) httpsPort++;
      if (httpsPort > 9699) throw new Error('No app port is available on the tailnet.');
      const target = `http://127.0.0.1:${port}`;
      try {
        await execute(['serve', '--bg', `--https=${httpsPort}`, target]);
        const after = await status();
        if (after.Web?.[`${base.hostname}:${httpsPort}`]?.Handlers['/']?.Proxy !== target) throw new Error('The app’s tailnet link could not be verified.');
        for (const namespace of ['Web', 'TCP'] as const) for (const [key, value] of Object.entries(before[namespace] ?? {})) {
          if (JSON.stringify(after[namespace]?.[key]) !== JSON.stringify(value)) throw new Error('Existing tailnet routes changed while starting the app.');
        }
      } catch (error) {
        if ((await status()).Web?.[`${base.hostname}:${httpsPort}`]?.Handlers['/']?.Proxy === target) await execute(['serve', `--https=${httpsPort}`, 'off']);
        throw error;
      }
      return { access: 'tailnet', url: `https://${base.hostname}:${httpsPort}/`, httpsPort };
    },
    async remove(app) {
      if (app.httpsPort === undefined) return;
      const key = `${new URL(app.url).hostname}:${app.httpsPort}`;
      if ((await status()).Web?.[key]?.Handlers['/']?.Proxy === `http://127.0.0.1:${app.loopbackPort}`) await execute(['serve', `--https=${app.httpsPort}`, 'off']);
    },
  };
}

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const contained = (root: string, file: string) => file === root || file.startsWith(root + sep);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const listen = (server: Server): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); const address = server.address();
    if (!address || typeof address === 'string') reject(new Error('No app port was allocated.')); else resolve(address.port); });
});
const closeServer = (server: Server) => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); });
function appHeaders(headers: import('node:http').IncomingHttpHeaders) {
  const clean = { ...headers }; delete clean.authorization;
  if (clean.cookie) clean.cookie = clean.cookie.split(';').filter(part => !part.trim().startsWith('jevellan_session=')).join(';');
  return clean;
}
type RunningApp = { record: ProjectApp; fingerprint: string; server: Server; sockets?: Set<import('node:stream').Duplex>; native?: NativeProcess };
const AppStateSchema = z.strictObject({ schema: z.literal('project-app-state-v1'), app: ProjectAppSchema, native: NativeProcessSchema.omit({ sessionId: true }).optional() });

/** Apps are separate resources: ending a model turn never terminates them. Shutdown stops only owned resources. */
export class ProjectApps {
  readonly #apps = new Map<string, RunningApp>();
  #pending: Promise<unknown> = Promise.resolve(); #closed = false;
  readonly ready: Promise<void>;
  constructor(readonly homes: Homes, readonly publisher: AppPublisher, readonly redactor: SecretRedactor) {
    this.ready = this.#recover(); this.#pending = this.ready;
  }
  async #recover(): Promise<void> {
    const root = this.homes.at('apps'); if (!existsSync(root)) return;
    for (const id of readdirSync(root).filter(id => /^app_[a-f0-9]{24}$/.test(id))) {
      const file = this.homes.at('apps', id, 'app.json'); if (!existsSync(file)) continue;
      const state = readDocument(file, AppStateSchema); if (state.app.state === 'stopped') continue;
      await this.publisher.remove(state.app); if (state.native) await terminateGroup({ pid: state.native.pid, pgid: state.native.pgid, ...(state.native.startIdentity ? { startIdentity: state.native.startIdentity } : {}) });
      const record = this.#save({ ...state.app, state: 'stopped', stoppedAt: new Date().toISOString() });
      this.#apps.set(id, { record, fingerprint: '', server: createServer() });
    }
  }
  #serial<T>(work: () => Promise<T>): Promise<T> { const result = this.#pending.then(work); this.#pending = result.catch(() => undefined); return result; }
  #save(record: ProjectApp, native?: NativeProcess): ProjectApp {
    writeDocument(this.homes.at('apps', record.id, 'app.json'), AppStateSchema, { schema: 'project-app-state-v1', app: record, ...(native ? { native } : {}) }); return record;
  }
  list(projectId: string): ProjectApp[] { return [...this.#apps.values()].filter(app => app.record.projectId === projectId).map(app => structuredClone(app.record)); }
  start(scope: AppScope, raw: unknown, signal?: AbortSignal): Promise<ProjectApp> { return this.#serial(async () => {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error('Apps are shutting down.');
    const input = ProjectAppInputSchema.parse(raw);
    const directory = await realpath(resolve(scope.cwd, input.directory));
    const roots = await Promise.all([realpath(scope.cwd), realpath(scope.projectDirectory)]);
    if (!roots.some(root => contained(root, directory))) throw new Error('An app must run inside this thread or its registered project checkout.');
    if (contained(this.homes.root, directory) || ['.claude', '.codex', '.cursor', '.gemini', '.basic-memory'].some(name => contained(join(this.homes.userHome, name), directory))) throw new Error('An app cannot serve agent or runtime homes.');
    if (!((await stat(directory)).isDirectory())) throw new Error('The app directory does not exist.');
    const fingerprint = createHash('sha256').update(JSON.stringify({ projectId: scope.projectId, input, directory })).digest('hex');
    const id = `app_${fingerprint.slice(0, 24)}`; const existing = this.#apps.get(id);
    if (existing?.record.state === 'running') {
      try { const response = await fetch(existing.record.url + input.healthPath.slice(1), { signal: AbortSignal.timeout(2000), redirect: 'manual' });
        const ready = response.status < 400; await response.body?.cancel(); if (ready) return structuredClone(existing.record);
      } catch { /* A dead resource must be stopped before it is replaced. */ }
      await this.#stop(scope.projectId, id);
    }
    let native: NativeProcess | undefined; let upstream = 0; let port = 0; let link: Link | undefined;
    const server = createServer(async (request, response) => {
      if (input.kind === 'command') {
        const headers = appHeaders(request.headers);
        const proxy = httpRequest({ hostname: '127.0.0.1', port: upstream, path: request.url, method: request.method, headers }, reply => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); });
        proxy.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('The app is unavailable.'); }); request.pipe(proxy); return;
      }
      try {
        if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) { response.writeHead(405).end(); return; }
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
        if (pathname.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden files are not app assets.');
        const file = await realpath(resolve(directory, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`));
        if (!contained(directory, file) || !mime[extname(file)]) throw new Error('Not an app asset.');
        const content = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)]!, 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : content);
      } catch { response.writeHead(404).end('Not found.'); }
    });
    const sockets = new Set<import('node:stream').Duplex>();
    server.on('upgrade', (request, socket, head) => {
      if (input.kind !== 'command') { socket.destroy(); return; }
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      const proxy = httpRequest({ hostname: '127.0.0.1', port: upstream, path: request.url, headers: appHeaders(request.headers) });
      proxy.on('upgrade', (reply, target, targetHead) => {
        sockets.add(target); target.once('close', () => sockets.delete(target));
        socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${reply.rawHeaders.reduce((lines, value, index) => lines + value + (index % 2 ? '\r\n' : ': '), '')}\r\n`);
        if (targetHead.length) socket.write(targetHead); if (head.length) target.write(head);
        target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy()); target.pipe(socket); socket.pipe(target);
      });
      proxy.on('response', reply => { reply.resume(); socket.destroy(); }); proxy.on('error', () => socket.destroy()); proxy.end();
    });
    try {
      if (input.kind === 'command') {
        // Reserve a free port without taking over any existing listener.
        const reservation = createServer(); upstream = await listen(reservation); await closeServer(reservation);
        const env: Record<string, string> = { HOME: this.homes.ensure('apps', id, 'home'), PORT: String(upstream), HOST: '127.0.0.1' };
        for (const key of ['PATH', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key]!;
        const args = input.args.map(arg => arg.replaceAll('{port}', String(upstream)).replaceAll('{host}', '127.0.0.1'));
        port = await listen(server);
        const launched = await spawnGroup(input.command!, args, { cwd: directory, env }); native = launched.native;
        this.#save(ProjectAppSchema.parse({ schema: 'project-app-v1', id, projectId: scope.projectId, threadId: scope.threadId, directory, kind: input.kind,
          state: 'running', loopbackPort: port, access: 'local', url: `http://127.0.0.1:${port}/`, startedAt: new Date().toISOString() }), native);
        launched.child.stdin.end(); launched.child.stdout.resume(); launched.child.stderr.resume();
        let exited = false; launched.child.once('exit', () => { exited = true; });
        launched.child.once('exit', () => {
          // A restart can reuse the app id before a queued exit is handled. Only this exact process may end its resource.
          void this.#serial(async () => { const current = this.#apps.get(id);
            if (current?.native === launched.native && current.record.state === 'running') await this.#stop(scope.projectId, id);
          }).catch(() => undefined);
        });
        let healthy = false;
        for (let n = 0; n < 100 && !healthy && !exited; n++) {
          signal?.throwIfAborted();
          try { const response = await fetch(`http://127.0.0.1:${upstream}${input.healthPath}`, { signal: AbortSignal.timeout(1000), redirect: 'manual' }); healthy = response.status < 400; await response.body?.cancel(); } catch { /* Retry readiness only. */ }
          if (!healthy) await wait(100);
        }
        if (!healthy || exited) throw new Error('The app command did not become ready. Check its command and health path.');
      } else {
        const index = await realpath(join(directory, 'index.html')); if (!contained(directory, index)) throw new Error('The app entry cannot link outside its directory.');
      }
      signal?.throwIfAborted(); if (!port) port = await listen(server); link = await this.publisher.publish(port);
      this.#save(ProjectAppSchema.parse({ schema: 'project-app-v1', id, projectId: scope.projectId, threadId: scope.threadId, directory, kind: input.kind,
        state: 'running', loopbackPort: port, ...link, startedAt: new Date().toISOString() }), native);
      const response = await fetch(link.url + input.healthPath.slice(1), { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      const ready = response.status < 400; await response.body?.cancel(); if (!ready) throw new Error('The app link did not answer successfully.');
      signal?.throwIfAborted();
      const record = this.#save(ProjectAppSchema.parse({ schema: 'project-app-v1', id, projectId: scope.projectId, threadId: scope.threadId, directory,
        kind: input.kind, state: 'running', loopbackPort: port, ...link, startedAt: new Date().toISOString() }), native);
      this.#apps.set(id, { record, server, sockets, fingerprint, ...(native ? { native } : {}) }); return structuredClone(record);
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      const cleanup = await Promise.allSettled([closeServer(server), ...(native ? [terminateGroup(native)] : []), ...(link ? [this.publisher.remove(ProjectAppSchema.parse({ schema: 'project-app-v1', id,
        projectId: scope.projectId, threadId: scope.threadId, directory, kind: input.kind, state: 'stopped', loopbackPort: port, ...link, startedAt: new Date().toISOString() }))] : [])]);
      const failure = cleanup.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw new Error(this.redactor.text('App startup cleanup failed. Restart Jevellan to retry its owned resource cleanup.'));
      const saved = this.homes.at('apps', id, 'app.json'); if (existsSync(saved)) this.#save({ ...readDocument(saved, AppStateSchema).app, state: 'stopped', stoppedAt: new Date().toISOString() });
      throw new Error(this.redactor.text(error instanceof Error ? error.message : 'The app could not start.'));
    }
  }); }
  stop(projectId: string, appId: string): Promise<ProjectApp> { return this.#serial(() => this.#stop(projectId, appId)); }
  async #stop(projectId: string, appId: string): Promise<ProjectApp> {
    const app = this.#apps.get(appId); if (!app || app.record.projectId !== projectId) throw new Error('This app does not belong to the project.');
    if (app.record.state === 'stopped') return structuredClone(app.record);
    for (const socket of app.sockets ?? []) socket.destroy();
    const cleanup = await Promise.allSettled([this.publisher.remove(app.record), closeServer(app.server), ...(app.native ? [terminateGroup(app.native)] : [])]);
    const failure = cleanup.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
    app.record = this.#save({ ...app.record, state: 'stopped', stoppedAt: new Date().toISOString() }); return structuredClone(app.record);
  }
  async close(): Promise<void> {
    this.#closed = true; await this.#pending;
    const results = await Promise.allSettled([...this.#apps.values()].map(app => this.stop(app.record.projectId, app.record.id)));
    const failure = results.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
}
