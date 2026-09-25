import { z } from 'zod';
import { HubUnavailable, TimestampSchema, writeDocument, type Homes, type SecretRedactor, type RiggingApplicationSchema } from '@jevellan/core';

export const SettingsSyncSchema = z.strictObject({
  schema: z.literal('settings-sync-v1'), at: TimestampSchema, status: z.enum(['applied', 'waiting', 'failed']), message: z.string().optional(),
});
export const SETTINGS_SYNC_INTERVAL_MS = 30_000;
type Options = { homes: Homes; redactor: SecretRedactor; ready: Promise<unknown>; apply(): Promise<z.infer<typeof RiggingApplicationSchema>>; timers?: boolean };

/** Recheck shared settings and owned delivery files without restarting any runtime. */
export class SettingsSync {
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<z.infer<typeof SettingsSyncSchema> | null> | undefined;
  #closed = false;
  constructor(readonly options: Options) {
    if (options.timers !== false) {
      this.#timer = setInterval(() => { void this.pulse().catch(() => undefined); }, SETTINGS_SYNC_INTERVAL_MS); this.#timer.unref();
      void this.pulse().catch(() => undefined);
    }
  }
  pulse(): Promise<z.infer<typeof SettingsSyncSchema> | null> {
    if (this.#closed) return Promise.resolve(null);
    return this.#pending ??= this.#apply().finally(() => { this.#pending = undefined; });
  }
  async #apply() {
    try {
      await this.options.ready; if (this.#closed) return null;
      const result = await this.options.apply(); if (this.#closed) return null;
      const failures = result.accounts.filter(account => account.error).map(account => account.error!);
      return this.#record(failures.length ? 'failed' : 'applied', failures.length ? failures.join('\n') : undefined);
    } catch (error) {
      if (this.#closed) return null;
      return this.#record(error instanceof HubUnavailable ? 'waiting' : 'failed', error instanceof Error ? error.message : 'Settings synchronization failed.');
    }
  }
  #record(status: z.infer<typeof SettingsSyncSchema>['status'], message?: string) {
    return writeDocument(this.options.homes.at('settings-sync.json'), SettingsSyncSchema, { schema: 'settings-sync-v1', at: new Date().toISOString(), status, ...(message === undefined ? {} : { message: this.options.redactor.text(message) }) });
  }
  async close() { this.#closed = true; clearInterval(this.#timer); await this.#pending; }
}
