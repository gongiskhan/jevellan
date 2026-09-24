import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { z } from 'zod';
import { DeviceConfigSchema, DeviceSchema, Homes, RiggingStore, VERSION, newId, readDocument, seedConfiguration, writeDocument, type DeviceConfig } from '@jevellan/core';
import { HubDatabase, UiAuth } from '@jevellan/mesh';
import { AccountService } from '@jevellan/accounts';
import { createRuntime as createClaude } from '@jevellan/runtime-claude';
import { createRuntime as createCodex, prepareApiKey } from '@jevellan/runtime-codex';
import type { RuntimeAdapter, RuntimeContext } from '@jevellan/runtime-contract';

export const RiggingApplicationSchema = z.strictObject({
  schema: z.literal('rigging-application-v1'), at: z.iso.datetime({ offset: true }),
  accounts: z.array(z.strictObject({ accountId: z.string(), runtime: z.string(), results: z.array(z.strictObject({ itemId: z.string(), applied: z.boolean(), reason: z.string().optional() })), error: z.string().optional() })),
});
export type ApplicationOptions = { homes?: Homes; port?: number; runtimes?: (context: RuntimeContext) => ReadonlyMap<string, RuntimeAdapter>; timers?: boolean };

export class Application {
  readonly homes: Homes; readonly hub: HubDatabase; readonly device: DeviceConfig;
  readonly accounts: AccountService; readonly auth: UiAuth; readonly rigging: RiggingStore;
  readonly runtimes: ReadonlyMap<string, RuntimeAdapter>;
  constructor(options: ApplicationOptions = {}) {
    this.homes = options.homes ?? new Homes(); this.homes.ensure();
    const devicePath = this.homes.at('device.json'); const url = `http://127.0.0.1:${options.port ?? 9771}`;
    this.device = existsSync(devicePath) ? readDocument(devicePath, DeviceConfigSchema) : writeDocument(devicePath, DeviceConfigSchema, { schema: 'device-config-v1', deviceId: newId('dev'), name: hostname(), role: 'hub', hubUrl: url, url, version: VERSION });
    this.hub = new HubDatabase(this.homes, this.device.role);
    try {
      if (!this.hub.configuration.current()) this.hub.configuration.put(seedConfiguration(), 0, { deviceId: this.device.deviceId, source: 'install' });
      this.hub.configuration.materialise(this.homes);
      if (!this.hub.get('devices', this.device.deviceId, DeviceSchema)) this.hub.put('devices', this.device.deviceId, DeviceSchema, { schema: 'device-v1', id: this.device.deviceId, name: this.device.name, role: this.device.role, url: this.device.url, os: process.platform, version: VERSION, joinedAt: new Date().toISOString() }, 0);
      const context: RuntimeContext = { homes: this.homes, daemonPid: process.pid, redactor: this.hub.redactor, saveSecret: async (id, value) => { this.accounts.captureSecret(id, value); } };
      this.runtimes = options.runtimes?.(context) ?? new Map([['claude', createClaude(context)], ['codex', createCodex(context)]]);
      this.accounts = new AccountService({ store: this.hub, vault: this.hub.vault, redactor: this.hub.redactor, homes: this.homes, deviceId: this.device.deviceId, configuration: this.hub.configuration, runtimes: this.runtimes,
        ...(!options.runtimes ? { prepare: async (account) => { if (account.account.runtime === 'codex' && account.account.kind === 'api-key') await prepareApiKey(account, context); } } : {}),
        ...(options.timers === undefined ? {} : { timers: options.timers }),
      });
      this.auth = new UiAuth(this.hub, this.hub.vault, this.device.deviceId);
      this.rigging = new RiggingStore(this.hub, this.hub.redactor, [...this.runtimes.keys()]);
    } catch (error) { this.hub.close(); throw error; }
  }
  async applyRigging() {
    const results: z.infer<typeof RiggingApplicationSchema>['accounts'] = [];
    for (const { account } of this.accounts.list()) {
      const runtime = this.runtimes.get(account.runtime);
      if (!runtime) { results.push({ accountId: account.id, runtime: account.runtime, results: [], error: 'This runtime is not installed.' }); continue; }
      try { results.push({ accountId: account.id, runtime: account.runtime, results: await runtime.materialiseRigging(this.homes.account(account.runtime, account.id), this.rigging.items(account.runtime)) }); }
      catch (error) { results.push({ accountId: account.id, runtime: account.runtime, results: [], error: this.hub.redactor.text(error instanceof Error ? error.message : 'Rigging could not be applied.') }); }
    }
    const value = RiggingApplicationSchema.parse({ schema: 'rigging-application-v1', at: new Date().toISOString(), accounts: results });
    const current = this.hub.get('rigging-application', this.device.deviceId, RiggingApplicationSchema);
    this.hub.put('rigging-application', this.device.deviceId, RiggingApplicationSchema, value, current?.revision ?? 0);
    return value;
  }
  async close(): Promise<void> { await this.accounts.close(); this.hub.close(); }
}
