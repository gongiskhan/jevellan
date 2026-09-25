import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { DaemonDiagnosticsSchema, DoctorControlSchema, VERSION, doctorControlPath, readDocument, writeDocument, type DiagnosticCheck } from '@jevellan/core';
import type { Application } from './application.js';

export class LocalDiagnostics {
  readonly #token = randomBytes(32).toString('base64url');
  constructor(readonly app: Application, origin: string) {
    app.redactor.add(this.#token);
    writeDocument(doctorControlPath(app.homes), DoctorControlSchema, { schema: 'doctor-control-v1', origin, token: this.#token });
  }
  authorized(request: IncomingMessage): boolean {
    if (request.socket.localAddress !== '127.0.0.1' || request.socket.remoteAddress !== '127.0.0.1' || request.headers.origin) return false;
    const candidate = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const token = Buffer.from(this.#token);
    return candidate.length === token.length && timingSafeEqual(candidate, token);
  }
  close(): void {
    const file = doctorControlPath(this.app.homes);
    if (existsSync(file) && readDocument(file, DoctorControlSchema).token === this.#token) unlinkSync(file);
  }
}

/** Only sanitized status summaries leave the daemon; credentials and identities stay in their stores. */
export async function diagnoseApplication(app: Application) {
  const check = async (id: DiagnosticCheck['id'], inspect: () => Promise<Omit<DiagnosticCheck, 'id'>>): Promise<DiagnosticCheck> => {
    try { return { id, ...await inspect() }; }
    catch { return { id, status: 'error', note: id === 'hub' ? 'The hub could not be reached.' : `The ${id === 'jev' ? 'Jev' : 'account status'} check could not complete. Check Settings.` }; }
  };
  const checks = await Promise.all([
    check('hub', async () => { await app.roster(); return { status: 'ok', note: app.member ? 'The hub answered an authenticated device request.' : 'This device is the hub; its database is available.' }; }),
    check('accounts', async () => {
      const accounts = (await app.accounts.list()).filter(view => view.account.enabled);
      if (!accounts.length) return { status: 'missing', note: 'No enabled accounts. Add an account in Settings.' };
      const statuses = accounts.map(view => view.statuses.find(status => status.deviceId === app.device.deviceId));
      const ready = statuses.filter(status => status?.auth === 'ready').length;
      const stale = statuses.filter(status => !status || Date.now() - Date.parse(status.observedAt) > 5 * 60_000 || status.lastError).length;
      return { status: ready !== accounts.length ? 'missing' : stale ? 'warning' : 'ok', note: `${ready} of ${accounts.length} enabled accounts last reported ready on this device.${stale ? ` ${stale} status checks need refreshing in Settings.` : ''}${ready !== accounts.length ? ' Check account logins in Settings.' : ''}` };
    }),
    check('jev', async () => {
      if (!(await app.state.jev.summary()).saved) return { status: 'missing', note: 'No Jev key is saved. Add it in Settings.' };
      const result = await app.checkJev(AbortSignal.timeout(10_000));
      if (result.status !== 'connected') return { status: 'error', note: 'Jev did not accept the connection check. Check its key and connection in Settings.' };
      return result.availableModels.includes(result.configuredModel) ? { status: 'ok', note: `Jev is reachable and the configured model is available.` } : { status: 'warning', note: 'Jev is reachable, but the configured model was not listed. Check Settings.' };
    }),
  ]);
  return DaemonDiagnosticsSchema.parse({ schema: 'daemon-diagnostics-v1', version: VERSION, checks });
}
