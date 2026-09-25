import { z } from 'zod';
import { DeviceSchema, HeartbeatSchema, IdSchema, TimestampSchema } from './schemas.js';

export function deviceOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    const parts = url.hostname.split('.').map(Number);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const tailnet = parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || tailnet))) return null;
    url.hostname = url.hostname.replace(/\.$/, '');
    return url.origin;
  } catch { return null; }
}
export const DeviceOriginSchema = z.string().max(2048).transform((value, ctx) => {
  const origin = deviceOrigin(value);
  if (origin === null) { ctx.addIssue({ code: 'custom', message: 'Use HTTPS, loopback HTTP or a Tailscale IPv4 HTTP address.' }); return z.NEVER; }
  return origin;
});

export function localDeviceRoute(value: string): string | null {
  const control = [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!value.startsWith('/') || value.startsWith('//') || control || /[\\\s]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|20|2f|5c|7f)/i.test(value)) return null;
  try {
    const base = 'https://jevellan.invalid'; const url = new URL(value, base);
    if (url.origin !== base) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}
export const DeviceRouteSchema = z.string().max(4096).transform((value, ctx) => {
  const route = localDeviceRoute(value);
  if (route === null) { ctx.addIssue({ code: 'custom', message: 'Expected a local page route.' }); return z.NEVER; }
  return route;
});
export const DevicePresenceSchema = z.enum(['online', 'stale', 'offline']);
export type DevicePresence = z.infer<typeof DevicePresenceSchema>;
export const DeviceViewSchema = z.strictObject({
  schema: z.literal('device-view-v1'), device: DeviceSchema, status: DevicePresenceSchema,
  heartbeat: HeartbeatSchema.nullable(), revoked: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;
export const JoinCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);
export const DeviceTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const JoinInvitationSchema = z.strictObject({
  schema: z.literal('join-invitation-v1'), code: JoinCodeSchema, expiresAt: TimestampSchema,
});
export const JoinDeviceInputSchema = z.strictObject({
  schema: z.literal('join-device-v1'), code: JoinCodeSchema, requestId: IdSchema,
  device: z.strictObject({ id: IdSchema, name: z.string().min(1).max(200), url: DeviceOriginSchema, os: z.enum(['darwin', 'linux']), version: z.string().min(1).max(100) }),
});
export type JoinDeviceInput = z.infer<typeof JoinDeviceInputSchema>;
/** Registry result, to be combined with UI authentication material by the join API. */
export const DeviceMembershipSchema = z.strictObject({
  schema: z.literal('device-membership-v1'), device: DeviceSchema, hub: DeviceSchema, token: DeviceTokenSchema,
});
export type DeviceMembership = z.infer<typeof DeviceMembershipSchema>;
export const DeviceSwitchInputSchema = z.strictObject({
  schema: z.literal('device-switch-input-v1'), targetDeviceId: IdSchema, route: DeviceRouteSchema,
});
export const DeviceSwitchSchema = z.strictObject({
  schema: z.literal('device-switch-v1'), token: DeviceTokenSchema, targetDeviceId: IdSchema,
  targetUrl: DeviceOriginSchema, expiresAt: TimestampSchema,
});
export const DeviceSwitchReceiptSchema = z.strictObject({
  schema: z.literal('device-switch-receipt-v1'), sourceDeviceId: IdSchema, targetDeviceId: IdSchema,
  route: DeviceRouteSchema,
});
export const UiSessionSchema = z.strictObject({
  schema: z.literal('ui-session-v1'), id: IdSchema, deviceId: IdSchema,
  generation: z.number().int().positive(), expiresAt: TimestampSchema,
});
export type UiSession = z.infer<typeof UiSessionSchema>;
export const UiSessionTokenSchema = z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const UiSigningMaterialSchema = z.strictObject({
  schema: z.literal('ui-signing-material-v1'), key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), generation: z.number().int().positive(),
});
export type UiSigningMaterial = z.infer<typeof UiSigningMaterialSchema>;
export const JoinedDeviceSchema = z.strictObject({
  schema: z.literal('joined-device-v1'), membership: DeviceMembershipSchema, authentication: UiSigningMaterialSchema,
});
export type JoinedDevice = z.infer<typeof JoinedDeviceSchema>;
export const DeviceRosterSchema = z.strictObject({
  schema: z.literal('device-roster-v1'), currentDeviceId: IdSchema, devices: z.array(DeviceViewSchema),
});
export const MeshSessionInputSchema = z.strictObject({
  schema: z.literal('mesh-session-input-v1'), token: UiSessionTokenSchema.nullable(),
});
export const MeshSessionStateSchema = z.strictObject({
  schema: z.literal('mesh-session-state-v1'), configured: z.boolean(), session: UiSessionSchema.nullable(),
});
export const PeerSessionInputSchema = z.strictObject({
  schema: z.literal('peer-session-input-v1'), sourceDeviceId: IdSchema, conversationId: IdSchema, token: UiSessionTokenSchema,
});
export type PeerSessionInput = z.infer<typeof PeerSessionInputSchema>;
export const PeerSessionStateSchema = z.strictObject({
  schema: z.literal('peer-session-state-v1'), sourceDeviceId: IdSchema, targetDeviceId: IdSchema,
  conversationId: IdSchema, session: UiSessionSchema.nullable(),
});
export const PeerLoginSessionInputSchema = z.strictObject({
  schema: z.literal('peer-login-session-input-v1'), sourceDeviceId: IdSchema, token: UiSessionTokenSchema,
});
export const PeerLoginSessionStateSchema = z.strictObject({
  schema: z.literal('peer-login-session-state-v1'), sourceDeviceId: IdSchema, targetDeviceId: IdSchema,
  session: UiSessionSchema.nullable(),
});
export const MeshSessionResultSchema = z.strictObject({
  schema: z.literal('mesh-session-result-v1'), token: UiSessionTokenSchema,
});
export const ConsumeSwitchSchema = z.strictObject({
  schema: z.literal('consume-switch-v1'), token: DeviceTokenSchema,
});
export const SwitchedSessionSchema = z.strictObject({
  schema: z.literal('switched-session-v1'), receipt: DeviceSwitchReceiptSchema, token: UiSessionTokenSchema,
});
export const MemberJoinInputSchema = z.strictObject({
  schema: z.literal('member-join-input-v1'), hubUrl: DeviceOriginSchema, code: JoinCodeSchema,
  device: JoinDeviceInputSchema.shape.device.omit({ id: true }),
});
export const MemberJoinPlanSchema = z.strictObject({
  schema: z.literal('member-join-plan-v1'), hubUrl: DeviceOriginSchema, requestId: IdSchema,
  device: JoinDeviceInputSchema.shape.device,
});
