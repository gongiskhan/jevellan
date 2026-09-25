import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DeviceMembershipSchema, DeviceSchema, DeviceSwitchInputSchema, DeviceSwitchReceiptSchema, DeviceSwitchSchema, DeviceTokenSchema, DeviceViewSchema, HeartbeatSchema, IdSchema, JoinDeviceInputSchema, JoinInvitationSchema, TimestampSchema, newId, stableJson, type Device, type DeviceMembership, type DevicePresence, type DeviceView } from '@jevellan/core';
import type { HubDatabase } from './database.js';

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const DEVICE_ONLINE_MS = 90_000;
export const DEVICE_OFFLINE_MS = 600_000;
export const JOIN_LIFETIME_MS = 600_000;
export const SWITCH_LIFETIME_MS = 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const JoinRecordSchema = z.strictObject({
  schema: z.literal('join-record-v1'), id: IdSchema, createdAt: TimestampSchema, expiresAt: TimestampSchema,
  consumed: z.strictObject({ requestId: IdSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/), deviceId: IdSchema, tokenRef: IdSchema }).nullable(),
});
const DeviceAuthorizationSchema = z.strictObject({
  schema: z.literal('device-authorization-v1'), deviceId: IdSchema, tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  tokenRef: IdSchema, revokedAt: TimestampSchema.nullable(),
});
const StoredHeartbeatSchema = z.strictObject({ schema: z.literal('stored-heartbeat-v1'), receivedAt: TimestampSchema, heartbeat: HeartbeatSchema });
const SwitchRecordSchema = z.strictObject({
  schema: z.literal('switch-record-v1'), id: IdSchema, sourceDeviceId: IdSchema, targetDeviceId: IdSchema,
  route: DeviceSwitchReceiptSchema.shape.route, createdAt: TimestampSchema, expiresAt: TimestampSchema, consumedAt: TimestampSchema.nullable(),
});

export function devicePresence(lastHeartbeatAt: string | null | undefined, now = Date.now()): DevicePresence {
  const at = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : NaN;
  const age = now - at;
  if (!Number.isFinite(age) || age < 0 || age >= DEVICE_OFFLINE_MS) return 'offline';
  return age < DEVICE_ONLINE_MS ? 'online' : 'stale';
}

/** Hub-only membership authority. HTTP callers must authenticate before passing a device identity. */
export class DeviceRegistry {
  constructor(private readonly hub: HubDatabase, readonly hubId: string, private readonly now = Date.now) {
    if (this.#device(hubId).role !== 'hub') throw new Error('The registry must belong to the hub device.');
  }
  #device(id: string): Device {
    return this.hub.get('devices', IdSchema.parse(id), DeviceSchema)?.document ?? fail('This device is not registered.', 404);
  }
  #authorization(id: string) { return this.hub.get('device-authorizations', id, DeviceAuthorizationSchema); }
  #active(id: string): Device {
    const device = this.#device(id);
    if (id !== this.hubId) {
      const authorization = this.#authorization(id);
      if (!authorization || authorization.document.revokedAt) fail('This device is no longer authorized.', 401);
    }
    return device;
  }
  invite() {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let code: string; let id: string;
    do {
      code = [...randomBytes(8)].map((byte) => alphabet[byte & 31]).join(''); id = hash(code);
    } while (this.hub.get('join-codes', id, JoinRecordSchema));
    const at = this.now(); const expiresAt = new Date(at + JOIN_LIFETIME_MS).toISOString();
    this.hub.put('join-codes', id, JoinRecordSchema, { schema: 'join-record-v1', id, createdAt: new Date(at).toISOString(), expiresAt, consumed: null }, 0);
    this.hub.redactor.add(code);
    return JoinInvitationSchema.parse({ schema: 'join-invitation-v1', code, expiresAt });
  }
  join(input: unknown): DeviceMembership {
    const request = JoinDeviceInputSchema.parse(input); const id = hash(request.code);
    const requestHash = hash(stableJson({ requestId: request.requestId, device: request.device }));
    this.hub.redactor.add(request.code);
    return this.hub.transaction(() => {
      const invitation = this.hub.get('join-codes', id, JoinRecordSchema); const at = this.now();
      if (!invitation || Date.parse(invitation.document.expiresAt) <= at) return fail('This join code is invalid or expired.', 401);
      const consumed = invitation.document.consumed;
      if (consumed) {
        if (consumed.requestId !== request.requestId || consumed.requestHash !== requestHash) return fail('This join code has already been used.', 409);
        const device = this.#active(consumed.deviceId);
        return DeviceMembershipSchema.parse({ schema: 'device-membership-v1', device, hub: this.#device(this.hubId), token: this.hub.vault.forLaunch(consumed.tokenRef) });
      }
      if (this.hub.get('devices', request.device.id, DeviceSchema)) return fail('This device identity is already registered.', 409);
      const device = DeviceSchema.parse({ schema: 'device-v1', ...request.device, role: 'member', joinedAt: new Date(at).toISOString() });
      const token = randomBytes(32).toString('base64url'); const tokenRef = newId('devicekey');
      this.hub.vault.put(tokenRef, token);
      this.hub.put('devices', device.id, DeviceSchema, device, 0);
      this.hub.put('device-authorizations', device.id, DeviceAuthorizationSchema, { schema: 'device-authorization-v1', deviceId: device.id, tokenHash: hash(token), tokenRef, revokedAt: null }, 0);
      this.hub.put('join-codes', id, JoinRecordSchema, { ...invitation.document, consumed: { requestId: request.requestId, requestHash, deviceId: device.id, tokenRef } }, invitation.revision);
      return DeviceMembershipSchema.parse({ schema: 'device-membership-v1', device, hub: this.#device(this.hubId), token });
    });
  }
  authenticate(token: unknown): Device {
    if (!DeviceTokenSchema.safeParse(token).success) return fail('Device authentication failed.', 401);
    const digest = hash(token as string);
    const authorization = this.hub.list('device-authorizations', DeviceAuthorizationSchema).find(({ document }) => document.tokenHash === digest && !document.revokedAt);
    if (!authorization) return fail('Device authentication failed.', 401);
    this.hub.redactor.add(token as string);
    return this.#active(authorization.document.deviceId);
  }
  revoke(deviceId: string): void {
    if (deviceId === this.hubId) return fail('The hub cannot revoke itself.', 409);
    this.hub.transaction(() => {
      this.#device(deviceId); const authorization = this.#authorization(deviceId);
      if (!authorization || authorization.document.revokedAt) return;
      this.hub.put('device-authorizations', deviceId, DeviceAuthorizationSchema, { ...authorization.document, revokedAt: new Date(this.now()).toISOString() }, authorization.revision);
      this.hub.vault.remove(authorization.document.tokenRef);
    });
  }
  heartbeat(deviceId: string, input: unknown): DeviceView {
    const heartbeat = HeartbeatSchema.parse(input);
    if (heartbeat.deviceId !== deviceId) return fail('A device cannot report another device’s heartbeat.', 403);
    return this.hub.transaction(() => {
      const device = this.#active(deviceId); const at = new Date(this.now()).toISOString();
      const previous = this.hub.get('heartbeats', deviceId, StoredHeartbeatSchema);
      this.hub.put('heartbeats', deviceId, StoredHeartbeatSchema, { schema: 'stored-heartbeat-v1', receivedAt: at, heartbeat }, previous?.revision ?? 0);
      const stored = this.hub.get('devices', deviceId, DeviceSchema)!;
      this.hub.put('devices', deviceId, DeviceSchema, { ...device, version: heartbeat.version, lastHeartbeatAt: at }, stored.revision);
      return this.view(deviceId);
    });
  }
  view(deviceId: string): DeviceView {
    const device = this.#device(deviceId); const authorization = this.#authorization(deviceId);
    const revoked = deviceId !== this.hubId && (!authorization || Boolean(authorization.document.revokedAt));
    const heartbeat = this.hub.get('heartbeats', deviceId, StoredHeartbeatSchema)?.document.heartbeat ?? null;
    return DeviceViewSchema.parse({ schema: 'device-view-v1', device, status: revoked ? 'offline' : devicePresence(device.lastHeartbeatAt, this.now()), heartbeat, revoked });
  }
  list(): DeviceView[] { return this.hub.list('devices', DeviceSchema).map(({ document }) => this.view(document.id)); }
  issueSwitch(sourceDeviceId: string, input: unknown) {
    const request = DeviceSwitchInputSchema.parse(input);
    return this.hub.transaction(() => {
      this.#active(sourceDeviceId); const target = this.#active(request.targetDeviceId);
      if (this.view(target.id).status === 'offline') return fail('This device is offline.', 409);
      const token = randomBytes(32).toString('base64url'); const id = hash(token); const at = this.now();
      const expiresAt = new Date(at + SWITCH_LIFETIME_MS).toISOString();
      this.hub.put('device-switches', id, SwitchRecordSchema, { schema: 'switch-record-v1', id, sourceDeviceId, targetDeviceId: target.id, route: request.route, createdAt: new Date(at).toISOString(), expiresAt, consumedAt: null }, 0);
      this.hub.redactor.add(token);
      return DeviceSwitchSchema.parse({ schema: 'device-switch-v1', token, targetDeviceId: target.id, targetUrl: target.url, expiresAt });
    });
  }
  consumeSwitch(targetDeviceId: string, token: unknown) {
    if (!DeviceTokenSchema.safeParse(token).success) return fail('This device switch is invalid or expired.', 401);
    return this.hub.transaction(() => {
      this.#active(targetDeviceId);
      const id = hash(token as string); const record = this.hub.get('device-switches', id, SwitchRecordSchema); const at = this.now();
      if (!record || record.document.targetDeviceId !== targetDeviceId || record.document.consumedAt || Date.parse(record.document.expiresAt) <= at) return fail('This device switch is invalid or expired.', 401);
      this.#active(record.document.sourceDeviceId);
      this.hub.put('device-switches', id, SwitchRecordSchema, { ...record.document, consumedAt: new Date(at).toISOString() }, record.revision);
      this.hub.redactor.add(token as string);
      return DeviceSwitchReceiptSchema.parse({ schema: 'device-switch-receipt-v1', sourceDeviceId: record.document.sourceDeviceId, targetDeviceId, route: record.document.route });
    });
  }
}
