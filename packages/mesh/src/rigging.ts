import { AddRiggingSchema, RiggingStore, RiggingViewSchema, UpdateRiggingSchema } from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { settingsMutation } from './settings-mutation.js';

export class HubRigging extends RiggingStore {
  constructor(readonly hub: HubDatabase, readonly deviceId: string, runtimes: readonly string[]) { super(hub, hub.redactor, runtimes); }
  override add(raw: unknown) {
    const input = AddRiggingSchema.parse(raw); const { clientRequestId, ...value } = input;
    const result = settingsMutation(this.hub, this.deviceId, 'rigging-add', value, clientRequestId, RiggingViewSchema, () => super.add(value));
    return this.get(result.item.id);
  }
  override update(id: string, raw: unknown) {
    const input = UpdateRiggingSchema.parse(raw); const { clientRequestId, ...value } = input;
    settingsMutation(this.hub, this.deviceId, 'rigging-update', { id, ...value }, clientRequestId, RiggingViewSchema, () => super.update(id, value));
    return this.get(id);
  }
}
