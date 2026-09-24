import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccountSchema, AccountStatusSchema, AccountUsageSchema, AuthSchema, EffortSchema, IdSchema, SecretSummarySchema, TimestampSchema, newId, reconcileMenu, type AccountStatus, type ConfigurationStore, type DocumentStore, type Homes, type SecretRedactor, type SecretVault } from '@jevellan/core';
import type { LoginSession, ResolvedAccount, RuntimeAdapter } from '@jevellan/runtime-contract';
import { applyAccountError } from './eligibility.js';

const PaidUseSchema = z.enum(['always', 'when-subscriptions-run-out', 'never']);
const SecretInputSchema = z.string().min(1).max(65_536);
export const AddAccountSchema = z.strictObject({
  schema: z.literal('add-account-v1'), runtime: IdSchema, label: z.string().trim().min(1).max(128),
  kind: z.enum(['subscription', 'api-key']), ceilingPct: z.number().min(0).max(100).default(90),
  paidUse: PaidUseSchema.optional(), secret: SecretInputSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'api-key' && (!value.paidUse || !value.secret)) ctx.addIssue({ code: 'custom', message: 'Enter the key and choose when Jevellan may use it.' });
  if (value.kind === 'subscription' && value.paidUse) ctx.addIssue({ code: 'custom', message: 'Paid-use policy applies only to API keys.' });
  if (value.runtime === 'codex' && value.kind === 'subscription' && value.secret) ctx.addIssue({ code: 'custom', message: 'Codex subscription sign-in belongs to this device.' });
});
export const UpdateAccountSchema = z.strictObject({
  schema: z.literal('update-account-v1'), revision: z.number().int().positive(), label: z.string().trim().min(1).max(128),
  enabled: z.boolean(), ceilingPct: z.number().min(0).max(100), paidUse: PaidUseSchema.optional(),
});
export const ReplaceCredentialSchema = z.strictObject({ schema: z.literal('replace-credential-v1'), revision: z.number().int().positive(), secret: SecretInputSchema });
export const AccountViewSchema = z.strictObject({
  schema: z.literal('account-view-v1'), revision: z.number().int().positive(), account: AccountSchema,
  statuses: z.array(AccountStatusSchema), secret: SecretSummarySchema.optional(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;
export const OfferedModelsSchema = z.strictObject({
  schema: z.literal('offered-models-v1'), runtime: IdSchema, accountId: IdSchema, observedAt: TimestampSchema,
  models: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1), efforts: z.array(EffortSchema).min(1) })),
});
export const AccountProbeSchema = z.strictObject({ auth: AuthSchema, usage: AccountUsageSchema.optional(), identity: AccountSchema.shape.identity, error: z.string().optional() });
export const LoginViewSchema = z.strictObject({
  schema: z.literal('login-view-v1'), id: IdSchema, accountId: IdSchema, deviceId: IdSchema,
  state: z.enum(['pending', 'checking', 'done', 'failed', 'cancelled']), instructions: z.string(),
  url: z.url().optional(), userCode: z.string().optional(), acceptsCode: z.boolean(), error: z.string().optional(),
});
type LoginRecord = { id: string; accountId: string; session: LoginSession; state: z.infer<typeof LoginViewSchema>['state']; error?: string; expiresAt: number; polling?: Promise<void> };
const AccountUseSchema = z.strictObject({ schema: z.literal('account-use-v1'), accountId: IdSchema, deviceId: IdSchema, at: TimestampSchema });
export type AccountServiceOptions = {
  store: DocumentStore; vault: SecretVault; redactor: SecretRedactor; homes: Homes; deviceId: string;
  runtimes: ReadonlyMap<string, RuntimeAdapter>; configuration: ConfigurationStore;
  prepare?: (account: ResolvedAccount) => Promise<void>; timers?: boolean;
};

export class AccountService {
  #probes = new Map<string, Promise<AccountStatus>>();
  #generations = new Map<string, number>();
  #logins = new Map<string, LoginRecord>();
  #loginStarts = new Map<string, Promise<z.infer<typeof LoginViewSchema>>>();
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
          else if (record.state === 'pending') void this.pollLogin(record.id).catch(() => undefined);
        }
      }, 1000); this.#loginTimer.unref();
    }
  }
  #runtime(id: string): RuntimeAdapter { const runtime = this.options.runtimes.get(id); if (!runtime) throw new Error('This runtime is not installed.'); return runtime; }
  #account(id: string) {
    const value = this.options.store.get('accounts', IdSchema.parse(id), AccountSchema);
    if (!value) throw Object.assign(new Error('Account not found.'), { status: 404 });
    return value;
  }
  #statusId(id: string): string { return createHash('sha256').update(`${id}\0${this.options.deviceId}`).digest('hex'); }
  status(id: string): AccountStatus {
    this.#account(id);
    return this.options.store.get('account-statuses', this.#statusId(id), AccountStatusSchema)?.document ?? AccountStatusSchema.parse({ schema: 'account-status-v1', accountId: id, deviceId: this.options.deviceId, auth: 'missing', observedAt: new Date().toISOString() });
  }
  #putStatus(value: AccountStatus): AccountStatus {
    const key = this.#statusId(value.accountId); const previous = this.options.store.get('account-statuses', key, AccountStatusSchema);
    return this.options.store.put('account-statuses', key, AccountStatusSchema, this.options.redactor.document(value), previous?.revision ?? 0).document;
  }
  get(id: string): AccountView {
    const { revision, document: account } = this.#account(id);
    const statuses = this.options.store.list('account-statuses', AccountStatusSchema).map((value) => value.document).filter((status) => status.accountId === id);
    if (!statuses.some((status) => status.deviceId === this.options.deviceId)) statuses.push(this.status(id));
    return AccountViewSchema.parse({ schema: 'account-view-v1', revision, account, statuses, ...(account.secretRef ? { secret: this.options.vault.summary(account.secretRef) } : {}) });
  }
  list(): AccountView[] { return this.options.store.list('accounts', AccountSchema).map((row) => this.get(row.document.id)); }
  add(input: unknown): AccountView {
    const value = AddAccountSchema.parse(input); const runtime = this.#runtime(value.runtime);
    if (!runtime.accountKinds.includes(value.kind)) throw new Error('This runtime does not support that account kind.');
    const account = AccountSchema.parse({ schema: 'account-v1', id: newId('acc'), runtime: value.runtime, label: value.label, kind: value.kind, enabled: true, ceilingPct: value.ceilingPct, credential: value.runtime === 'codex' && value.kind === 'subscription' ? 'per-device' : 'shared', ...(value.paidUse ? { paidUse: value.paidUse } : {}) });
    this.options.store.put('accounts', account.id, AccountSchema, account, 0);
    if (value.secret) this.captureSecret(account.id, value.secret);
    return this.get(account.id);
  }
  update(id: string, input: unknown): AccountView {
    const patch = UpdateAccountSchema.parse(input); const { document: account } = this.#account(id);
    delete account.paidUse;
    this.options.store.put('accounts', id, AccountSchema, { ...account, label: patch.label, enabled: patch.enabled, ceilingPct: patch.ceilingPct, ...(patch.paidUse ? { paidUse: patch.paidUse } : {}) }, patch.revision);
    return this.get(id);
  }
  /** Login capture only: the terminal driver has already validated completion. */
  captureSecret(id: string, input: string): void {
    const value = SecretInputSchema.parse(input); const current = this.#account(id);
    if (current.document.credential !== 'shared') throw new Error('This account uses a device-local login.');
    const secretRef = newId('secret'); this.options.vault.put(secretRef, value);
    try { this.options.store.put('accounts', id, AccountSchema, { ...current.document, secretRef }, current.revision); }
    catch (error) { this.options.vault.remove(secretRef); throw error; }
    this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1);
    this.#probes.delete(id);
    this.#putStatus({ schema: 'account-status-v1', accountId: id, deviceId: this.options.deviceId, auth: 'checking', observedAt: new Date().toISOString() });
    if (current.document.secretRef) this.options.vault.remove(current.document.secretRef);
  }
  async replaceCredential(id: string, input: unknown): Promise<AccountView> {
    const value = ReplaceCredentialSchema.parse(input);
    if (this.#account(id).revision !== value.revision) throw Object.assign(new Error('This account changed. Reload it before saving.'), { status: 409 });
    for (const record of this.#logins.values()) if (record.accountId === id && ['pending', 'checking'].includes(record.state)) await this.cancelLogin(record.id);
    if (this.#account(id).revision !== value.revision) throw Object.assign(new Error('This account changed. Reload it before saving.'), { status: 409 });
    this.captureSecret(id, value.secret); await this.check(id); return this.get(id);
  }
  async resolve(id: string, forLaunch = true): Promise<ResolvedAccount> {
    const account = this.#account(id).document;
    if (account.credential === 'hub-refreshed') throw new Error('Hub-refreshed logins are not supported yet.');
    const home = this.options.homes.account(account.runtime, id); const env: Record<string, string> = {};
    if (account.credential === 'shared') {
      if (!account.secretRef) throw new Error('This account needs login.');
      const key = account.runtime === 'claude' ? account.kind === 'subscription' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY' : account.runtime === 'codex' ? 'OPENAI_API_KEY' : undefined;
      if (!key) throw new Error('Credential delivery is unavailable for this runtime.');
      env[key] = this.options.vault.forLaunch(account.secretRef);
    }
    const resolved = { account, home, env };
    if (this.options.prepare) {
      const previous = this.#prepare.get(id) ?? Promise.resolve();
      const prepared = previous.catch(() => undefined).then(() => this.options.prepare!(resolved)); this.#prepare.set(id, prepared);
      try { await prepared; } finally { if (this.#prepare.get(id) === prepared) this.#prepare.delete(id); }
    }
    // Codex's key was fed to its owned login process, never the stretch environment.
    if (forLaunch) delete env.OPENAI_API_KEY;
    return resolved;
  }
  check(id: string): Promise<AccountStatus> {
    if (this.#closed) return Promise.reject(new Error('Account service is closed.'));
    const pending = this.#probes.get(id); if (pending) return pending;
    const task = this.#check(id); this.#probes.set(id, task);
    void task.finally(() => { if (this.#probes.get(id) === task) this.#probes.delete(id); }).catch(() => undefined);
    return task;
  }
  async #check(id: string): Promise<AccountStatus> {
    const account = this.#account(id).document; const before = this.status(id); const generation = this.#generations.get(id) ?? 0;
    this.#putStatus({ ...before, auth: 'checking', observedAt: new Date().toISOString() });
    let probe: z.infer<typeof AccountProbeSchema>;
    if (account.credential === 'shared' && !account.secretRef) probe = { auth: 'needs-login' };
    else {
      try { probe = AccountProbeSchema.parse(await this.#runtime(account.runtime).probe(await this.resolve(id, false))); }
      catch { probe = { auth: 'unknown', error: 'The account check could not complete. Usage is unknown.' }; }
    }
    if (this.#closed || generation !== (this.#generations.get(id) ?? 0) || this.#account(id).document.secretRef !== account.secretRef) return this.status(id);
    const now = new Date().toISOString();
    const value = AccountStatusSchema.parse({
      schema: 'account-status-v1', accountId: id, deviceId: this.options.deviceId,
      auth: probe.auth === 'unknown' && before.auth === 'ready' ? 'ready' : probe.auth,
      usage: probe.usage ?? { source: 'unknown', observedAt: now }, observedAt: now,
      ...(before.coolingUntil && Date.parse(before.coolingUntil) > Date.now() ? { coolingUntil: before.coolingUntil } : {}),
      ...(probe.error ? { lastError: this.options.redactor.text(probe.error) } : {}),
    });
    if (probe.identity) {
      const current = this.#account(id);
      this.options.store.put('accounts', id, AccountSchema, { ...current.document, identity: this.options.redactor.document(probe.identity) }, current.revision);
    }
    return this.#putStatus(value);
  }
  async discover(id: string) {
    const account = this.#account(id).document;
    const models = await this.#runtime(account.runtime).listModels(await this.resolve(id));
    const value = OfferedModelsSchema.parse({ schema: 'offered-models-v1', runtime: account.runtime, accountId: id, observedAt: new Date().toISOString(), models });
    const current = this.options.store.get('offered-models', account.runtime, OfferedModelsSchema);
    this.options.store.put('offered-models', account.runtime, OfferedModelsSchema, value, current?.revision ?? 0);
    // Re-read after discovery: a user may have edited descriptions while it ran.
    const revision = this.options.configuration.current();
    if (revision) {
      const configuration = globalThis.structuredClone(revision.configuration);
      configuration['x-jevellan'].menu = reconcileMenu(configuration['x-jevellan'].menu, account.runtime, value.models);
      if (JSON.stringify(configuration) !== JSON.stringify(revision.configuration)) {
        this.options.configuration.put(configuration, revision.revision, { deviceId: this.options.deviceId, source: 'ui' });
        this.options.configuration.materialise(this.options.homes);
      }
    }
    return value;
  }
  offered() { return this.options.store.list('offered-models', OfferedModelsSchema).map((value) => value.document); }
  recordError(id: string, kind: 'rate-limit' | 'auth' | 'other'): AccountStatus { return this.#putStatus(applyAccountError(this.status(id), kind)); }
  recordUsage(id: string, usage: unknown): AccountStatus { return this.#putStatus({ ...this.status(id), usage: AccountUsageSchema.parse(usage), observedAt: new Date().toISOString() }); }
  markUsed(id: string): void {
    this.#account(id); const key = this.#statusId(id); const previous = this.options.store.get('account-use', key, AccountUseSchema);
    this.options.store.put('account-use', key, AccountUseSchema, { schema: 'account-use-v1', accountId: id, deviceId: this.options.deviceId, at: new Date().toISOString() }, previous?.revision ?? 0);
  }
  async probeRecent(): Promise<void> {
    const recent = this.options.store.list('account-use', AccountUseSchema).map((value) => value.document).filter((value) => value.deviceId === this.options.deviceId && Date.parse(value.at) >= Date.now() - 60 * 60_000);
    await Promise.allSettled(recent.filter((value) => this.#account(value.accountId).document.enabled).map((value) => this.check(value.accountId)));
  }
  beginLogin(id: string): Promise<z.infer<typeof LoginViewSchema>> {
    if (this.#closed) return Promise.reject(new Error('Account service is closed.'));
    const pending = this.#loginStarts.get(id); if (pending) return pending;
    const task = this.#beginLogin(id); this.#loginStarts.set(id, task);
    void task.finally(() => { if (this.#loginStarts.get(id) === task) this.#loginStarts.delete(id); }).catch(() => undefined);
    return task;
  }
  async #beginLogin(id: string) {
    const account = this.#account(id).document;
    if (account.kind !== 'subscription') throw new Error('Enter an API key in the account form.');
    for (const record of this.#logins.values()) if (record.accountId === id && ['pending', 'checking'].includes(record.state)) return this.#loginView(record);
    this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1); this.#probes.delete(id);
    const session = await this.#runtime(account.runtime).beginLogin(account, this.options.homes.account(account.runtime, id));
    if (this.#closed) { await session.cancel(); throw new Error('Account service is closed.'); }
    const record: LoginRecord = { id: newId('login'), accountId: id, session, state: 'pending', expiresAt: Date.now() + 30 * 60_000 };
    this.#logins.set(record.id, record); return this.#loginView(record);
  }
  #login(id: string): LoginRecord { const record = this.#logins.get(IdSchema.parse(id)); if (!record) throw Object.assign(new Error('Login not found.'), { status: 404 }); return record; }
  #loginView(record: LoginRecord) {
    const { session } = record;
    return LoginViewSchema.parse({ schema: 'login-view-v1', id: record.id, accountId: record.accountId, deviceId: this.options.deviceId, state: record.state, instructions: session.instructions, ...(session.url ? { url: session.url } : {}), ...(session.userCode ? { userCode: session.userCode } : {}), acceptsCode: Boolean(session.submitCode && !session.userCode), ...(record.error ? { error: record.error } : {}) });
  }
  async pollLogin(id: string) {
    const record = this.#login(id);
    if (record.state === 'pending') {
      record.polling ??= (async () => {
        try {
          const state = await record.session.poll();
          if (record.state !== 'pending' || this.#closed) return;
          if (state === 'failed') { record.state = 'failed'; record.error = 'Login did not complete. Try again.'; }
          if (state === 'done') {
            record.state = 'checking'; const status = await this.check(record.accountId);
            if (record.state !== 'checking' || this.#closed) return;
            record.state = status.auth === 'ready' ? 'done' : 'failed';
            if (record.state === 'failed') record.error = 'Login completed, but readiness could not be confirmed. Check the account again.';
            else await this.discover(record.accountId).catch(() => undefined);
          }
        } catch { if (record.state !== 'cancelled') { record.state = 'failed'; record.error = 'Login could not be checked. Try again.'; } }
      })();
      try { await record.polling; } finally { delete record.polling; }
    } else if (record.polling) await record.polling;
    return this.#loginView(record);
  }
  async submitLogin(id: string, code: string) {
    const record = this.#login(id);
    if (record.state !== 'pending' || !record.session.submitCode) throw new Error('This login is not waiting for a code.');
    await record.session.submitCode(z.string().min(1).max(16_384).parse(code)); return this.pollLogin(id);
  }
  async cancelLogin(id: string): Promise<void> {
    const record = this.#login(id); record.state = 'cancelled';
    await record.session.cancel();
  }
  async close(): Promise<void> {
    this.#closed = true; clearInterval(this.#probeTimer); clearInterval(this.#loginTimer);
    await Promise.allSettled(this.#loginStarts.values());
    await Promise.allSettled([...this.#logins.values()].map((record) => this.cancelLogin(record.id)));
    await Promise.allSettled([...this.#probes.values(), ...this.#prepare.values()]);
  }
}
