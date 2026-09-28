import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  CursorConnectionsSchema, CursorListSchema, CursorTranscriptSchema, CursorMessageSchema, CursorHookSetupSchema,
  CursorMessageInputSchema, CursorHookInstallationSchema, readDocument, writeDocument, type CursorConnection, type Homes,
} from '@jevellan/core/cursor';
import type { CursorRequest } from './cursor-stdio.js';

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const ErrorSchema = z.object({ schema: z.literal('cursor-error-v1'), message: z.string() });
export function cursorSshArguments(connection: CursorConnection): string[] {
  const options = ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8'];
  const command = `${connection.workingDirectory ? `cd ${quote(connection.workingDirectory)} && ` : ''}${quote(connection.nodePath)} ${quote(connection.helperPath)}`;
  const target = [...options, '-p', String(connection.port),
    ...(connection.identityFile ? ['-i', connection.identityFile, '-o', 'IdentitiesOnly=yes'] : []), `${connection.user}@127.0.0.1`, command];
  // The second SSH client runs on the existing gateway and uses its existing
  // CSG identity. No identity copying, forwarding options or listeners.
  return connection.gateway
    ? [...options, `${connection.gateway.user}@${connection.gateway.host}`, ['ssh', ...target].map(quote).join(' ')]
    : target;
}
export class CursorSessions {
  #cache = new Map<string, z.infer<typeof CursorListSchema>>();
  #pending = new Map<string, Promise<z.infer<typeof CursorListSchema>>>();
  constructor(readonly homes: Homes, readonly deviceId: string, readonly deviceName: string) {}
  connections() {
    const path = this.homes.at('cursor', 'connections.json');
    return existsSync(path) ? readDocument(path, CursorConnectionsSchema) : CursorConnectionsSchema.parse({ schema: 'cursor-connections-v1', connections: [] });
  }
  saveConnections(value: unknown) {
    const parsed = CursorConnectionsSchema.parse(value);
    if (parsed.connections.some(row => !row.id.startsWith('cursor_remote_'))) throw new Error('Cursor connection IDs must start with cursor_remote_.');
    this.#cache.clear();
    return writeDocument(this.homes.at('cursor', 'connections.json'), CursorConnectionsSchema, parsed);
  }
  async #request(request: CursorRequest, connection?: CursorConnection): Promise<unknown> {
    const value: unknown = await new Promise((resolve, reject) => {
      if (!connection) {
        const worker = new Worker(new URL('./cursor-stdio.js', import.meta.url), { workerData: request });
        const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Cursor did not respond in time.')); }, 12_000);
        worker.once('message', value => { clearTimeout(timer); resolve(value); });
        worker.once('error', () => { clearTimeout(timer); reject(new Error('Cursor could not be read on this device.')); });
        worker.once('exit', () => { clearTimeout(timer); reject(new Error('Cursor reader stopped.')); });
      } else {
        const child = spawn('ssh', cursorSshArguments(connection), { stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks: Buffer[] = []; let size = 0;
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${connection.name}: the existing dev tunnel did not respond.`)); }, 15_000);
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024 * 1024) { child.kill(); reject(new Error('Cursor transcript exceeds the transfer limit.')); } else chunks.push(chunk); });
        child.once('error', () => { clearTimeout(timer); reject(new Error(`${connection.name}: SSH is unavailable.`)); });
        child.once('exit', code => {
          clearTimeout(timer);
          try { if (code !== 0) throw new Error(); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error(`${connection.name}: check the existing dev tunnel connection and installed helper.`)); }
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(JSON.stringify(request) + '\n');
      }
    });
    const error = ErrorSchema.safeParse(value); if (error.success) throw new Error(error.data.message);
    return value;
  }
  #target(deviceId: string) {
    if (deviceId === this.deviceId) return undefined;
    const connection = this.connections().connections.find(row => row.id === deviceId);
    if (!connection) throw new Error('Cursor connection not found on this device.');
    return connection;
  }
  #input(deviceId: string, operation: CursorRequest['operation'], projectPaths: string[] = []): CursorRequest {
    const connection = this.#target(deviceId);
    return { schema: 'cursor-request-v1', operation,
      home: connection?.home ?? this.homes.root, deviceId, deviceName: connection?.name ?? this.deviceName,
      ...(!connection ? { userHome: this.homes.userHome } : {}), projectPaths };
  }
  async list(projectPaths: string[] = []) {
    const targets = [this.deviceId, ...this.connections().connections.map(row => row.id)];
    const lists = await Promise.all(targets.map(async target => {
      const cached = this.#cache.get(target);
      if (cached && Date.now() - Date.parse(cached.observedAt) < 2000) return cached;
      let pending = this.#pending.get(target);
      if (!pending) {
        pending = this.#request(this.#input(target, 'list', projectPaths), this.#target(target)).then(value => {
          const list = CursorListSchema.parse(value);
          const excluded = new Set([...cached?.excludedSessionIds ?? [], ...list.excludedSessionIds]);
          list.excludedSessionIds = [...excluded];
          list.sessions = list.sessions.filter(row => !excluded.has(row.id));
          // An unavailable source must not make known sessions vanish.
          if (list.unavailable.length && cached) {
            const known = new Set([...list.sessions.map(row => row.id), ...list.excludedSessionIds]);
            list.sessions.push(...cached.sessions.filter(row => !known.has(row.id) && Date.now() - Date.parse(row.lastActivityAt) < 5 * 86_400_000)
              .map(row => ({ ...row, connected: false, state: 'unknown' as const, canSteer: false, canSend: false })));
          }
          this.#cache.set(target, list); return list;
        }).finally(() => this.#pending.delete(target));
        this.#pending.set(target, pending);
      }
      try { return await pending; }
      catch (error) {
        return { schema: 'cursor-list-v1' as const, observedAt: new Date().toISOString(), unavailable: [error instanceof Error ? error.message : 'Cursor is unavailable.'],
          sessions: (cached?.sessions ?? []).filter(row => Date.now() - Date.parse(row.lastActivityAt) < 5 * 86_400_000)
            .map(row => ({ ...row, connected: false, state: 'unknown' as const, canSteer: false, canSend: false })) };
      }
    }));
    return CursorListSchema.parse({ schema: 'cursor-list-v1', observedAt: new Date().toISOString(), sessions: lists.flatMap(row => row.sessions), unavailable: lists.flatMap(row => row.unavailable) });
  }
  async read(deviceId: string, id: string, paths: string[] = []) {
    return CursorTranscriptSchema.parse(await this.#request({ ...this.#input(deviceId, 'read', paths), id }, this.#target(deviceId)));
  }
  async send(deviceId: string, id: string, message: unknown) {
    return CursorMessageSchema.parse(await this.#request({ ...this.#input(deviceId, 'send'), id, message: CursorMessageInputSchema.parse(message) }, this.#target(deviceId)));
  }
  async cancel(deviceId: string, id: string, messageId: string) {
    return CursorMessageSchema.parse(await this.#request({ ...this.#input(deviceId, 'cancel'), id, messageId }, this.#target(deviceId)));
  }
  hookSetup(deviceId: string) {
    const target = this.#target(deviceId);
    const manifest = this.homes.at('cursor', 'bridge', 'installation.json');
    const installed = !target && existsSync(manifest) ? readDocument(manifest, CursorHookInstallationSchema) : null;
    const helper = target ? join(dirname(target.helperPath), target.helperPath.endsWith('.mjs') ? 'cursor-hook.mjs' : 'cursor-hook.js') : installed?.hookPath ?? fileURLToPath(new URL('./cursor-hook.js', import.meta.url));
    const command = target?.hookCommand ?? installed?.command ?? `${quote(target?.nodePath ?? installed?.executable ?? process.execPath)} ${quote(helper)} ${quote(target?.home ?? this.homes.root)}`;
    return CursorHookSetupSchema.parse({ schema: 'cursor-hook-setup-v1', configuration: JSON.stringify({ version: 1, hooks: Object.fromEntries(
      ['beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'afterAgentResponse', 'afterAgentThought', 'stop', 'sessionEnd'].map(name => [name, [{ command, timeout: name === 'stop' ? 25_260 : 10, ...(name === 'stop' ? { loop_limit: null } : {}) }]])
    ) }, null, 2) });
  }
}
