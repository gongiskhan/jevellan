import { createHash } from 'node:crypto';
import { AccountHubRequestSchema, AccountHubResultSchema, AccountModelsResultSchema, AccountSchema, AccountStatusSchema, AccountUseSchema, AccountViewSchema, AddAccountSchema, CredentialInputSchema, IdSchema, OfferedModelsSchema, UpdateAccountSchema, newId, reconcileMenu, type Account, type AccountStatus, type AccountStore } from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { AccountCredentialSchema, AccountListSchema, AccountWriteResultSchema, CredentialCaptureReceiptSchema, OfferedModelsListSchema, RecentAccountsSchema, stableJson, type AccountHubRequest, type DocumentSchema } from '@jevellan/core';
import { HubProtocolError, type MemberHubClient } from './client.js';
import { settingsMutation } from './settings-mutation.js';

type WithoutSchema<T> = T extends { schema: unknown } ? Omit<T, 'schema'> : never;
const key = (id: string, device: string) => createHash('sha256').update(`${id}\0${device}`).digest('hex');
const failure = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };

/** Hub authority for account data; native runtimes remain on their owning device. */
export class HubAccounts implements AccountStore {
  constructor(readonly hub: HubDatabase, readonly deviceId: string, private readonly now = Date.now) { IdSchema.parse(deviceId); }
  #account(id: string) { return this.hub.get('accounts', IdSchema.parse(id), AccountSchema) ?? failure('Account not found.', 404); }
  status(id: string): AccountStatus {
    this.#account(id);
    return this.hub.get('account-statuses', key(id, this.deviceId), AccountStatusSchema)?.document ?? AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: id, deviceId: this.deviceId, auth: 'missing', observedAt: new Date(this.now()).toISOString() });
  }
  get(id: string) {
    const { revision, document: account } = this.#account(id);
    const statuses = this.hub.list('account-statuses', AccountStatusSchema).map(row => row.document).filter(status => status.accountId === id);
    if (!statuses.some(status => status.deviceId === this.deviceId)) statuses.push(this.status(id));
    return AccountViewSchema.parse({ schema: 'account-view-v1', revision, account, statuses, ...(account.secretRef ? { secret: this.hub.vault.summary(account.secretRef) } : {}) });
  }
  list() { return this.hub.list('accounts', AccountSchema).map(row => this.get(row.document.id)); }
  add(input: unknown) {
    const value = AddAccountSchema.parse(input);
    const result = settingsMutation(this.hub, this.deviceId, 'account-add', value, value.clientRequestId, AccountViewSchema, () => {
      const account = AccountSchema.parse({ schema: 'account-v1', id: newId('acc'), runtime: value.runtime, label: value.label, kind: value.kind, enabled: true, ceilingPct: value.ceilingPct, credential: value.runtime === 'codex' && value.kind === 'subscription' ? 'per-device' : 'shared', ...(value.paidUse ? { paidUse: value.paidUse } : {}) });
      this.hub.put('accounts', account.id, AccountSchema, account, 0);
      return value.secret ? this.capture(account.id, 1, value.secret) : this.get(account.id);
    });
    return this.get(result.account.id);
  }
  update(id: string, input: unknown) {
    const patch = UpdateAccountSchema.parse(input);
    settingsMutation(this.hub, this.deviceId, 'account-update', { id, ...patch }, patch.clientRequestId, AccountViewSchema, () => {
      const { document: account } = this.#account(id); delete account.paidUse;
      this.hub.put('accounts', id, AccountSchema, { ...account, label: patch.label, enabled: patch.enabled, ceilingPct: patch.ceilingPct, ...(patch.paidUse ? { paidUse: patch.paidUse } : {}) }, patch.revision);
      return this.get(id);
    });
    return this.get(id);
  }
  capture(id: string, revision: number, raw: string, requestId?: string) {
    const secret = CredentialInputSchema.parse(raw);
    const receiptId = requestId === undefined ? undefined : key(IdSchema.parse(requestId), this.deviceId);
    const fingerprint = this.hub.vault.requestFingerprint(stableJson({ id, revision, secret, deviceId: this.deviceId }));
    return this.hub.transaction(() => {
      const current = this.#account(id);
      if (receiptId) {
        const saved = this.hub.get('credential-captures', receiptId, CredentialCaptureReceiptSchema)?.document;
        if (saved) {
          if (saved.requestId !== requestId || saved.deviceId !== this.deviceId || saved.accountId !== id || saved.fingerprint !== fingerprint) return failure('This credential request was already used for a different save.', 409);
          if (current.document.secretRef !== saved.secretRef) return failure('This account credential changed after this login. Start a new login.', 409);
          return this.get(id);
        }
      }
      if (current.revision !== revision) return failure('This account changed. Reload it before saving.', 409);
      if (current.document.credential !== 'shared') throw new Error('This account uses a device-local login.');
      const secretRef = newId('secret'); this.hub.vault.put(secretRef, secret);
      delete current.document.identity;
      this.hub.put('accounts', id, AccountSchema, { ...current.document, secretRef }, current.revision);
      const statuses = this.hub.list('account-statuses', AccountStatusSchema).filter(row => row.document.accountId === id);
      if (!statuses.some(row => row.document.deviceId === this.deviceId)) statuses.push({ revision: 0, document: this.status(id) });
      for (const row of statuses) this.hub.put('account-statuses', key(id, row.document.deviceId), AccountStatusSchema, {
        schema: 'account-status-v2', accountId: id, deviceId: row.document.deviceId, auth: 'checking', observedAt: new Date(this.now()).toISOString(),
      }, row.revision);
      if (current.document.secretRef) this.hub.vault.remove(current.document.secretRef);
      if (receiptId) this.hub.put('credential-captures', receiptId, CredentialCaptureReceiptSchema, { schema: 'credential-capture-receipt-v1', requestId, deviceId: this.deviceId, accountId: id, fingerprint, secretRef }, 0);
      return this.get(id);
    });
  }
  credential(id: string, secretRef: string): string {
    const account = this.#account(id).document;
    if (account.credential !== 'shared' || !account.secretRef || account.secretRef !== IdSchema.parse(secretRef)) return failure('This account credential changed. Check the account again.', 409);
    return this.hub.vault.forLaunch(account.secretRef);
  }
  writeStatus(raw: AccountStatus, credential: string | null, identity?: Account['identity']): AccountStatus {
    const status = AccountStatusSchema.parse(raw);
    if (status.deviceId !== this.deviceId) return failure('An account status belongs to its reporting device.', 403);
    return this.hub.transaction(() => {
      const account = this.#account(status.accountId);
      if ((account.document.secretRef ?? null) !== credential) return this.status(status.accountId);
      if (identity) this.hub.put('accounts', status.accountId, AccountSchema, { ...account.document, identity: this.hub.redactor.document(identity) }, account.revision);
      const id = key(status.accountId, this.deviceId); const current = this.hub.get('account-statuses', id, AccountStatusSchema);
      return this.hub.put('account-statuses', id, AccountStatusSchema, this.hub.redactor.document(status), current?.revision ?? 0).document;
    });
  }
  models() { return this.hub.list('offered-models', OfferedModelsSchema).map(row => row.document); }
  recordModels(id: string, models: ReturnType<typeof OfferedModelsSchema.parse>['models']) {
    const account = this.#account(id).document;
    const offered = OfferedModelsSchema.parse({ schema: 'offered-models-v1', accountId: id, runtime: account.runtime, models, observedAt: new Date(this.now()).toISOString() });
    const previous = this.hub.get('offered-models', account.runtime, OfferedModelsSchema);
    this.hub.put('offered-models', account.runtime, OfferedModelsSchema, offered, previous?.revision ?? 0);
    let revision = this.hub.configuration.current();
    if (revision) {
      const configuration = globalThis.structuredClone(revision.configuration);
      configuration['x-jevellan'].menu = reconcileMenu(configuration['x-jevellan'].menu, account.runtime, offered.models);
      if (JSON.stringify(configuration) !== JSON.stringify(revision.configuration)) revision = this.hub.configuration.put(configuration, revision.revision, { deviceId: this.deviceId, source: 'ui' });
    }
    return AccountModelsResultSchema.parse({ schema: 'account-models-result-v1', offered, configuration: revision });
  }
  markUsed(id: string): void {
    this.#account(id); const documentId = key(id, this.deviceId); const previous = this.hub.get('account-use', documentId, AccountUseSchema);
    this.hub.put('account-use', documentId, AccountUseSchema, { schema: 'account-use-v1', accountId: id, deviceId: this.deviceId, at: new Date(this.now()).toISOString() }, previous?.revision ?? 0);
  }
  recent(): string[] {
    return this.hub.list('account-use', AccountUseSchema).map(row => row.document).filter(value => value.deviceId === this.deviceId && Date.parse(value.at) >= this.now() - 60 * 60_000 && this.#account(value.accountId).document.enabled).map(value => value.accountId);
  }
  request(input: unknown) {
    const value = AccountHubRequestSchema.parse(input);
    const run = () => {
      switch (value.operation) {
        case 'get': return this.get(value.id);
        case 'list': return { schema: 'accounts-list-v1', accounts: this.list() };
        case 'add': return this.add(value.input);
        case 'update': return this.update(value.id, value.input);
        case 'status': return this.status(value.id);
        case 'write-status': return this.writeStatus(value.status, value.credential, value.identity);
        case 'capture': return this.capture(value.id, value.revision, value.secret, value.requestId);
        case 'credential': return { schema: 'account-credential-v1', accountId: value.id, secretRef: value.secretRef, value: this.credential(value.id, value.secretRef) };
        case 'models': return { schema: 'offered-models-list-v1', offered: this.models() };
        case 'record-models': return this.recordModels(value.id, value.models);
        case 'mark-used': this.markUsed(value.id); return { schema: 'account-write-result-v1', applied: true };
        case 'recent': return { schema: 'recent-accounts-v1', accountIds: this.recent() };
      }
    };
    return AccountHubResultSchema.parse(run());
  }
}

export class MemberAccounts implements AccountStore {
  constructor(readonly client: MemberHubClient) {}
  async #request<T>(input: WithoutSchema<AccountHubRequest>, schema: DocumentSchema<T>): Promise<T> {
    const result = await this.client.accountData({ schema: 'account-hub-request-v1', ...input });
    try { return schema.parse(result); } catch { throw new HubProtocolError(); }
  }
  async get(id: string) {
    const result = await this.#request({ operation: 'get', id }, AccountViewSchema);
    if (result.account.id !== id) throw new HubProtocolError(); return result;
  }
  async list() { return (await this.#request({ operation: 'list' }, AccountListSchema)).accounts; }
  add(input: unknown) { return this.#request({ operation: 'add', input: AddAccountSchema.parse(input) }, AccountViewSchema); }
  async update(id: string, input: unknown) {
    const result = await this.#request({ operation: 'update', id, input: UpdateAccountSchema.parse(input) }, AccountViewSchema);
    if (result.account.id !== id) throw new HubProtocolError(); return result;
  }
  async status(id: string) {
    const result = await this.#request({ operation: 'status', id }, AccountStatusSchema);
    if (result.accountId !== id || result.deviceId !== this.client.deviceId) throw new HubProtocolError(); return result;
  }
  async writeStatus(status: AccountStatus, credential: string | null, identity?: Account['identity']) {
    const result = await this.#request({ operation: 'write-status', status, credential, ...(identity ? { identity } : {}) }, AccountStatusSchema);
    if (result.accountId !== status.accountId || result.deviceId !== this.client.deviceId) throw new HubProtocolError(); return result;
  }
  async capture(id: string, revision: number, secret: string, requestId?: string) {
    const result = await this.#request({ operation: 'capture', id, revision, secret, ...(requestId ? { requestId } : {}) }, AccountViewSchema);
    if (result.account.id !== id) throw new HubProtocolError(); return result;
  }
  async credential(id: string, secretRef: string) {
    const result = await this.#request({ operation: 'credential', id, secretRef }, AccountCredentialSchema);
    if (result.accountId !== id || result.secretRef !== secretRef) throw new HubProtocolError(); return result.value;
  }
  async models() { return (await this.#request({ operation: 'models' }, OfferedModelsListSchema)).offered; }
  async recordModels(id: string, models: ReturnType<typeof OfferedModelsSchema.parse>['models']) {
    const result = await this.#request({ operation: 'record-models', id, models }, AccountModelsResultSchema);
    if (result.offered.accountId !== id) throw new HubProtocolError(); return result;
  }
  async markUsed(id: string) { await this.#request({ operation: 'mark-used', id }, AccountWriteResultSchema); }
  async recent() { return (await this.#request({ operation: 'recent' }, RecentAccountsSchema)).accountIds; }
}
