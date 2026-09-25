import { JoinedDeviceSchema, MeshSessionStateSchema, SwitchedSessionSchema, DeviceRosterSchema, ConversationIndexSchema, PeerSessionInputSchema, PeerSessionStateSchema } from '@jevellan/core';
import type { HubDatabase } from './database.js';
import type { DeviceRegistry } from './devices.js';
import type { UiAuth } from './auth.js';
import { PeerLoginSessionInputSchema, PeerLoginSessionStateSchema } from '@jevellan/core';

/** Membership and shared sign-in operations whose authority stays on the hub. */
export class HubMesh {
  #joinAttempts = new Map<string, { count: number; expiresAt: number }>();
  constructor(readonly database: HubDatabase, readonly devices: DeviceRegistry, readonly auth: UiAuth, private readonly now = Date.now) {}
  invite() {
    if (!this.auth.configured()) throw Object.assign(new Error('Set the hub passphrase before adding a device.'), { status: 409 });
    return this.devices.invite();
  }
  join(input: unknown, address: string) {
    const now = this.now();
    for (const [key, value] of this.#joinAttempts) if (value.expiresAt <= now) this.#joinAttempts.delete(key);
    const entry = this.#joinAttempts.get(address) ?? { count: 0, expiresAt: now + 60_000 };
    if (entry.count >= 10 || this.#joinAttempts.size >= 10_000 && !this.#joinAttempts.has(address)) throw Object.assign(new Error('Too many join attempts. Try again in a minute.'), { status: 429 });
    entry.count++; this.#joinAttempts.set(address, entry);
    return this.database.transaction(() => {
      if (!this.auth.configured()) throw Object.assign(new Error('Set the hub passphrase before adding a device.'), { status: 409 });
      const authentication = this.auth.signingMaterial();
      const membership = this.devices.join(input);
      return JoinedDeviceSchema.parse({ schema: 'joined-device-v1', membership, authentication });
    });
  }
  roster(deviceId: string) { return DeviceRosterSchema.parse({ schema: 'device-roster-v1', currentDeviceId: deviceId, devices: this.devices.list() }); }
  session(deviceId: string, token: string | null) {
    return MeshSessionStateSchema.parse({ schema: 'mesh-session-state-v1', configured: this.auth.configured(), session: this.auth.verify(token ?? undefined, deviceId) });
  }
  peerSession(targetDeviceId: string, raw: unknown) {
    const input = PeerSessionInputSchema.parse(raw); this.database.redactor.add(input.token);
    for (const deviceId of [input.sourceDeviceId, targetDeviceId]) {
      if (this.devices.view(deviceId).revoked) throw Object.assign(new Error('This device is no longer authorized.'), { status: 401 });
    }
    const conversation = this.database.get('conversations', input.conversationId, ConversationIndexSchema)?.document;
    if (!conversation || conversation.ownerDeviceId !== targetDeviceId) throw Object.assign(new Error('This conversation is not owned by the receiving device.'), { status: 409 });
    return PeerSessionStateSchema.parse({ schema: 'peer-session-state-v1', sourceDeviceId: input.sourceDeviceId, targetDeviceId, conversationId: input.conversationId, session: this.auth.verify(input.token, input.sourceDeviceId) });
  }
  consumeSwitch(deviceId: string, token: string) {
    return this.database.transaction(() => {
      const receipt = this.devices.consumeSwitch(deviceId, token);
      return SwitchedSessionSchema.parse({ schema: 'switched-session-v1', receipt, token: this.auth.issue(deviceId) });
    });
  }
  peerLoginSession(targetDeviceId: string, raw: unknown) {
    const input = PeerLoginSessionInputSchema.parse(raw); this.database.redactor.add(input.token);
    for (const deviceId of [input.sourceDeviceId, targetDeviceId]) {
      if (this.devices.view(deviceId).revoked) throw Object.assign(new Error('This device is no longer authorized.'), { status: 401 });
    }
    return PeerLoginSessionStateSchema.parse({ schema: 'peer-login-session-state-v1', sourceDeviceId: input.sourceDeviceId, targetDeviceId, session: this.auth.verify(input.token, input.sourceDeviceId) });
  }
}
