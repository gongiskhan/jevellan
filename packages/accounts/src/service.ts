import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { HubUnavailable, readDocument, writeDocument } from '@jevellan/core';
import { AccountStatusSchema, AccountUsageSchema, IdSchema, AddAccountSchema, ReplaceCredentialSchema, AccountProbeSchema, LoginViewSchema, CredentialInputSchema, materialiseConfiguration, newId, type AccountStatus, type AccountView, type AccountStore, type Homes, type SecretRedactor } from '@jevellan/core';
import type { LoginSession, ResolvedAccount, RuntimeAdapter } from '@jevellan/runtime-contract';
import { applyAccountError } from './eligibility.js';

type LoginRecord = { id: string; accountId: string; session: LoginSession; state: z.infer<typeof LoginViewSchema>['state']; error?: string; expiresAt: number; polling?: Promise<void>; submission?: { fingerprint: string; accepted: boolean; promise: Promise<void> } };
const LoginRequestReceiptSchema = z.strictObject({ schema: z.literal('login-request-receipt-v1'), requestId: IdSchema, deviceId: IdSchema, accountId: IdSchema, loginId: IdSchema.nullable() });
export type AccountServiceOptions = {
  store: AccountStore; redactor: SecretRedactor; homes: Homes; deviceId: string;
  runtimes: ReadonlyMap<string, RuntimeAdapter>;
  prepare?: (account: ResolvedAccount) => Promise<void>; timers?: boolean;
  configurationChanged?: () => Promise<void>;
};

export class AccountService {
  #operations = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  #probes = new Map<string, Promise<AccountStatus>>();
  #generations = new Map<string, number>();
  #logins = new Map<string, LoginRecord>();
  #loginStarts = new Map<string, Promise<z.infer<typeof LoginViewSchema>>>();
  #loginRequests = new Map<string, string>();
  #loginPendingRequests = new Set<string>();
  #captures = new Map<string, { fingerprint: string; revision: Promise<number>; expiresAt: number; applied?: boolean }>();
  #prepare = new Map<string, Promise<void>>();
  #probeTimer: ReturnType<typeof setInterval> | undefined;
  #loginTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  constructor(private readonly options: AccountServiceOptions) {
    IdSchema.parse(options.deviceId);
    if (options.timers !== false) {
      this.#probeTimer = setInterval(() => { void this.probeRecent().catch(() => undefined); }, 5 * 60_000); this.#probeTimer.unref();
      this.#loginTimer = setInterval(() => {
        for (const record of this.#logins.values()) {
          if (record.expiresAt <= Date.now()) { void this.cancelLogin(record.id).then(() => this.#logins.delete(record.id)).catch(() => undefined); }
          else if (['pending', 'checking'].includes(record.state)) void this.pollLogin(record.id).catch(() => undefined);
        }
      }, 1000); this.#loginTimer.unref();
    }
  }
  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Account service is closed.'));
    let task: Promise<T>;
    try { task = operation(); } catch (error) { return Promise.reject(error); }
    this.#operations.add(task);
    void task.then(() => this.#operations.delete(task), () => this.#operations.delete(task));
    return task;
  }
  #runtime(id: string): RuntimeAdapter { const runtime = this.options.runtimes.get(id); if (!runtime) throw new Error('This runtime is not installed.'); return runtime; }
  async #account(id: string) {
    if (this.#closed) throw new Error('Account service is closed.');
    const value = await this.options.store.get(IdSchema.parse(id));
    if (this.#closed) throw new Error('Account service is closed.');
    return value;
  }
  status(id: string): Promise<AccountStatus> { return this.#run(async () => this.options.store.status(id)); }
  get(id: string): Promise<AccountView> { return this.#run(() => this.#account(id)); }
  list(): Promise<AccountView[]> { return this.#run(async () => this.options.store.list()); }
  add(input: unknown): Promise<AccountView> {
    return this.#run(async () => {
      const value = AddAccountSchema.parse(input); const runtime = this.#runtime(value.runtime);
      if (!runtime.accountKinds.includes(value.kind)) throw new Error('This runtime does not support that account kind.');
      return this.options.store.add(value);
    });
  }
  update(id: string, input: unknown): Promise<AccountView> { return this.#run(async () => this.options.store.update(id, input)); }
  /** Login capture only: the terminal driver has already validated completion. */
  captureSecret(id: string, input: string, expectedRevision?: number, requestId?: string): Promise<void> {
    return this.#run(async () => {
      const value = CredentialInputSchema.parse(input); let revision = expectedRevision;
      if (requestId !== undefined) {
        const key = `${IdSchema.parse(id)}/${IdSchema.parse(requestId)}`;
        const fingerprint = createHash('sha256').update(JSON.stringify({ value, expectedRevision })).digest('hex');
        let intent = this.#captures.get(key);
        if (intent && (intent.fingerprint !== fingerprint || intent.expiresAt <= Date.now())) throw Object.assign(new Error('This login capture changed or expired. Start a new login.'), { status: 409 });
        if (!intent) {
          intent = { fingerprint, revision: revision === undefined ? this.#account(id).then(account => account.revision) : Promise.resolve(revision), expiresAt: Date.now() + 30 * 60_000 };
          this.#captures.set(key, intent);
        }
        try { revision = await intent.revision; }
        catch (error) { if (this.#captures.get(key) === intent) this.#captures.delete(key); throw error; }
      }
      if (revision === undefined) revision = (await this.#account(id)).revision;
      await this.options.store.capture(id, revision, value, requestId);
      const captured = requestId === undefined ? undefined : this.#captures.get(`${id}/${requestId}`);
      if (!captured?.applied) { this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1); this.#probes.delete(id); }
      if (captured) captured.applied = true;
    });
  }
  replaceCredential(id: string, input: unknown): Promise<AccountView> { return this.#run(() => this.#replaceCredential(id, input)); }
  async #replaceCredential(id: string, input: unknown): Promise<AccountView> {
    const value = ReplaceCredentialSchema.parse(input);
    if ((await this.#account(id)).revision !== value.revision) {
      if (!value.clientRequestId) throw Object.assign(new Error('This account changed. Reload it before saving.'), { status: 409 });
    } else {
      for (const record of this.#logins.values()) if (record.accountId === id && ['pending', 'checking'].includes(record.state)) await this.cancelLogin(record.id);
      if ((await this.#account(id)).revision !== value.revision) throw Object.assign(new Error('This account changed. Reload it before saving.'), { status: 409 });
    }
    // A submitted Settings key has an explicit revision and no provider-login deadline.
    await this.options.store.capture(id, value.revision, value.secret, value.clientRequestId);
    this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1); this.#probes.delete(id);
    await this.check(id); return this.get(id);
  }
  resolve(id: string, forLaunch = true): Promise<ResolvedAccount> { return this.#run(() => this.#resolve(id, forLaunch)); }
  async #resolve(id: string, forLaunch: boolean): Promise<ResolvedAccount> {
    const account = (await this.#account(id)).account;
    if (account.credential === 'hub-refreshed') throw new Error('Hub-refreshed logins are not supported yet.');
    const home = this.options.homes.account(account.runtime, id); const env: Record<string, string> = {};
    if (account.credential === 'shared') {
      if (!account.secretRef) throw new Error('This account needs login.');
      const key = account.runtime === 'claude' ? account.kind === 'subscription' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY' : account.runtime === 'codex' ? 'OPENAI_API_KEY' : undefined;
      if (!key) throw new Error('Credential delivery is unavailable for this runtime.');
      env[key] = await this.options.store.credential(id, account.secretRef);
    }
    const resolved = { account, home, env };
    if (this.#closed) throw new Error('Account service is closed.');
    if (this.options.prepare) {
      const previous = this.#prepare.get(id) ?? Promise.resolve();
      const prepared = previous.catch(() => undefined).then(() => {
        if (this.#closed) throw new Error('Account service is closed.');
        return this.options.prepare!(resolved);
      }); this.#prepare.set(id, prepared);
      try { await prepared; } finally { if (this.#prepare.get(id) === prepared) this.#prepare.delete(id); }
    }
    if (this.#closed) throw new Error('Account service is closed.');
    // Codex's key was fed to its owned login process, never the stretch environment.
    if (forLaunch) delete env.OPENAI_API_KEY;
    return resolved;
  }
  check(id: string): Promise<AccountStatus> {
    if (this.#closed) return Promise.reject(new Error('Account service is closed.'));
    const pending = this.#probes.get(id); if (pending) return pending;
    const task = this.#run(() => this.#check(id)); this.#probes.set(id, task);
    void task.finally(() => { if (this.#probes.get(id) === task) this.#probes.delete(id); }).catch(() => undefined);
    return task;
  }
  async #check(id: string): Promise<AccountStatus> {
    const account = (await this.#account(id)).account; const before = await this.status(id); const generation = this.#generations.get(id) ?? 0;
    await this.options.store.writeStatus({ ...before, auth: 'checking', observedAt: new Date().toISOString() }, account.secretRef ?? null);
    let probe: z.infer<typeof AccountProbeSchema>;
    if (account.credential === 'shared' && !account.secretRef) probe = { auth: 'needs-login' };
    else {
      try { probe = AccountProbeSchema.parse(await this.#runtime(account.runtime).probe(await this.resolve(id, false))); }
      catch (error) { if (error instanceof HubUnavailable) throw error; probe = { auth: 'unknown', error: 'The account check could not complete. Usage is unknown.' }; }
    }
    if (this.#closed) return before;
    if (generation !== (this.#generations.get(id) ?? 0) || (await this.#account(id)).account.secretRef !== account.secretRef) return this.status(id);
    const now = new Date().toISOString();
    const value = AccountStatusSchema.parse({
      schema: 'account-status-v1', accountId: id, deviceId: this.options.deviceId,
      auth: probe.auth === 'unknown' && before.auth === 'ready' ? 'ready' : probe.auth,
      usage: probe.usage ?? { source: 'unknown', observedAt: now }, observedAt: now,
      ...(before.coolingUntil && Date.parse(before.coolingUntil) > Date.now() ? { coolingUntil: before.coolingUntil } : {}),
      ...(probe.error ? { lastError: this.options.redactor.text(probe.error) } : {}),
    });
    return this.options.store.writeStatus(value, account.secretRef ?? null, probe.identity);
  }

  discover(id: string) { return this.#run(() => this.#discover(id)); }
  async #discover(id: string) {
    const account = (await this.#account(id)).account;
    const models = await this.#runtime(account.runtime).listModels(await this.resolve(id));
    if (this.#closed) throw new Error('Account service is closed.');
    const result = await this.options.store.recordModels(id, models);
    if (this.#closed) throw new Error('Account service is closed.');
    if (result.configuration) {
      if (this.options.configurationChanged) await this.options.configurationChanged();
      else materialiseConfiguration(this.options.homes, result.configuration);
    }
    return result.offered;
  }
  offered() { return this.#run(async () => this.options.store.models()); }
  recordError(id: string, kind: 'rate-limit' | 'auth' | 'other', credential?: string | null): Promise<AccountStatus> {
    return this.#run(async () => {
      const account = await this.#account(id); const status = await this.status(id);
      return this.options.store.writeStatus(applyAccountError(status, kind), credential === undefined ? account.account.secretRef ?? null : credential);
    });
  }
  recordUsage(id: string, usage: unknown, credential?: string | null): Promise<AccountStatus> {
    return this.#run(async () => {
      const account = await this.#account(id); const status = await this.status(id);
      return this.options.store.writeStatus({ ...status, usage: AccountUsageSchema.parse(usage), observedAt: new Date().toISOString() }, credential === undefined ? account.account.secretRef ?? null : credential);
    });
  }
  markUsed(id: string): Promise<void> { return this.#run(async () => this.options.store.markUsed(id)); }
  probeRecent(): Promise<void> { return this.#run(() => this.#probeRecent()); }
  async #probeRecent(): Promise<void> {
    const recent = await this.options.store.recent();
    if (this.#closed) return;
    await Promise.allSettled(recent.map(id => this.check(id)));
  }
  beginLogin(id: string, requestId?: string): Promise<z.infer<typeof LoginViewSchema>> {
    if (this.#closed) return Promise.reject(new Error('Account service is closed.'));
    const key = requestId === undefined ? undefined : `${IdSchema.parse(id)}/${IdSchema.parse(requestId)}`;
    const previous = key ? this.#loginRequests.get(key) : undefined;
    if (previous) return Promise.resolve(this.#loginView(this.#login(previous)));
    const receiptPath = requestId === undefined ? undefined : this.options.homes.at('auth', 'login-requests', `${requestId}.json`);
    if (receiptPath && existsSync(receiptPath)) {
      const saved = readDocument(receiptPath, LoginRequestReceiptSchema);
      if (saved.accountId !== id || saved.requestId !== requestId || saved.deviceId !== this.options.deviceId || !this.#loginPendingRequests.has(key!)) return Promise.reject(Object.assign(new Error('This login request was interrupted or already finished. Start a new login.'), { status: 409 }));
    }
    if (key) this.#loginPendingRequests.add(key);
    let task = this.#loginStarts.get(id);
    if (!task) {
      const started = this.#run(() => this.#beginLogin(id, requestId)); task = started; this.#loginStarts.set(id, started);
      void started.finally(() => { if (this.#loginStarts.get(id) === started) this.#loginStarts.delete(id); }).catch(() => undefined);
    }
    return task.then(view => {
      if (key && receiptPath) {
        if (existsSync(receiptPath)) {
          const saved = readDocument(receiptPath, LoginRequestReceiptSchema);
          if (saved.accountId !== id || saved.deviceId !== this.options.deviceId || saved.requestId !== requestId) throw Object.assign(new Error('This login request belongs to another account.'), { status: 409 });
        }
        writeDocument(receiptPath, LoginRequestReceiptSchema, { schema: 'login-request-receipt-v1', requestId, deviceId: this.options.deviceId, accountId: id, loginId: view.id });
        this.#loginRequests.set(key, view.id);
      }
      return view;
    }).finally(() => { if (key) this.#loginPendingRequests.delete(key); });
  }
  async #beginLogin(id: string, requestId?: string) {
    const account = (await this.#account(id)).account;
    if (account.kind !== 'subscription') throw new Error('Enter an API key in the account form.');
    for (const record of this.#logins.values()) if (record.accountId === id && ['pending', 'checking'].includes(record.state)) return this.#loginView(record);
    this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1); this.#probes.delete(id);
    if (requestId !== undefined) {
      const file = this.options.homes.at('auth', 'login-requests', `${requestId}.json`);
      if (existsSync(file)) throw Object.assign(new Error('This login request was already used. Start a new login.'), { status: 409 });
      writeDocument(file, LoginRequestReceiptSchema, { schema: 'login-request-receipt-v1', requestId, deviceId: this.options.deviceId, accountId: id, loginId: null });
    }
    const session = await this.#runtime(account.runtime).beginLogin(account, this.options.homes.account(account.runtime, id));
    if (this.#closed) { await session.cancel(); throw new Error('Account service is closed.'); }
    const record: LoginRecord = { id: newId('login'), accountId: id, session, state: 'pending', expiresAt: Date.now() + 30 * 60_000 };
    this.#logins.set(record.id, record); return this.#loginView(record);
  }
  #login(id: string): LoginRecord { const record = this.#logins.get(IdSchema.parse(id)); if (!record) throw Object.assign(new Error('Login not found.'), { status: 404 }); return record; }
  #loginView(record: LoginRecord) {
    const { session } = record;
    return LoginViewSchema.parse({ schema: 'login-view-v1', id: record.id, accountId: record.accountId, deviceId: this.options.deviceId, state: record.state, instructions: session.instructions, ...(session.url ? { url: session.url } : {}), ...(session.userCode ? { userCode: session.userCode } : {}), acceptsCode: Boolean(record.state === 'pending' && !record.submission && session.submitCode && !session.userCode), ...(record.error ? { error: record.error } : {}) });
  }
  pollLogin(id: string) { return this.#run(() => this.#pollLogin(id)); }
  async #pollLogin(id: string) {
    const record = this.#login(id);
    if (['pending', 'checking'].includes(record.state)) {
      const pending = record.polling ??= (async () => {
        try {
          delete record.error;
          if (record.state === 'pending') {
            const state = await record.session.poll();
            if (record.state !== 'pending' || this.#closed) return;
            if (state === 'failed') { record.state = 'failed'; record.error = this.options.redactor.text(record.session.error ?? 'Login did not complete. Try again.'); }
            if (state === 'done') record.state = 'checking';
          }
          if (record.state === 'checking') {
            const status = await this.check(record.accountId);
            if (record.state !== 'checking' || this.#closed) return;
            record.state = status.auth === 'ready' ? 'done' : 'failed';
            if (record.state === 'failed') record.error = 'Login completed, but readiness could not be confirmed. Check the account again.';
            else await this.discover(record.accountId).catch(() => undefined);
          }
        } catch (error) {
          if (record.state === 'cancelled' || this.#closed) return;
          if (error instanceof HubUnavailable) { record.error = error.message; throw error; }
          record.state = 'failed'; record.error = 'Login could not be checked. Try again.';
        }
      })();
      try { await pending; } finally { if (record.polling === pending) delete record.polling; }
    } else if (record.polling) await record.polling;
    return this.#loginView(record);
  }
  submitLogin(id: string, code: string) { return this.#run(() => this.#submitLogin(id, code)); }
  loginSubmissionAccepted(id: string): boolean { return this.#logins.get(id)?.submission?.accepted === true; }
  async #submitLogin(id: string, code: string) {
    const record = this.#login(id);
    const value = z.string().min(1).max(16_384).parse(code); const fingerprint = createHash('sha256').update(value).digest('hex');
    if (record.submission) {
      if (record.submission.fingerprint !== fingerprint) throw Object.assign(new Error('This login already received a different code. Start a new login.'), { status: 409 });
    } else {
      if (record.state !== 'pending' || !record.session.submitCode) throw new Error('This login is not waiting for a code.');
      record.session.validateCode?.(value);
      const submission = { fingerprint, accepted: false, promise: Promise.resolve() };
      submission.promise = Promise.resolve().then(() => record.session.submitCode!(value)).then(() => { submission.accepted = true; });
      record.submission = submission;
    }
    await record.submission.promise; return this.pollLogin(id);
  }
  cancelLogin(id: string): Promise<void> { return this.#run(() => this.#cancelLogin(id)); }
  async #cancelLogin(id: string): Promise<void> {
    const record = this.#login(id); record.state = 'cancelled';
    await record.session.cancel();
  }
  close(): Promise<void> { return this.#closing ??= this.#close(); }
  async #close(): Promise<void> {
    this.#closed = true; clearInterval(this.#probeTimer); clearInterval(this.#loginTimer);
    await Promise.allSettled(this.#loginStarts.values());
    await Promise.allSettled([...this.#logins.values()].map((record) => this.#cancelLogin(record.id)));
    while (this.#operations.size) await Promise.allSettled(this.#operations);
  }
}

export { AddAccountSchema, UpdateAccountSchema, ReplaceCredentialSchema, AccountViewSchema, OfferedModelsSchema, AccountProbeSchema, LoginViewSchema, type AccountView } from '@jevellan/core';
