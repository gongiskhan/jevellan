import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonOwnership, DeviceConfigSchema, DeviceOriginSchema, DeviceSchema, DeviceTokenSchema, MemberJoinInputSchema, MemberJoinPlanSchema, UiSigningMaterialSchema, atomicWrite, newId, readDocument, stableJson, writeDocument, type Homes, type SecretRedactor } from '@jevellan/core';
import { HubProtocolError, MemberHubClient, MemberUiAuth, joinHub } from './client.js';

type ConnectionOptions = { redactor: SecretRedactor; fetch?: typeof fetch; timeoutMs?: number };
function file(homes: Homes, name: string): string {
  const path = homes.at(name);
  if (path !== join(homes.root, name)) throw new Error('Member authentication files cannot alias another path.');
  return path;
}
function privateFile(homes: Homes, name: string): string {
  const path = file(homes, name); const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Member authentication files must be private regular files.');
  return path;
}
const tokenReader = (homes: Homes) => () => DeviceTokenSchema.parse(readFileSync(privateFile(homes, 'device.token'), 'utf8').trim());

/** Opens local authentication files only. Shared application data remains on the hub. */
export function memberConnection(homes: Homes, options: ConnectionOptions) {
  const device = readDocument(file(homes, 'device.json'), DeviceConfigSchema);
  const hub = readDocument(file(homes, 'hub-device.json'), DeviceSchema);
  if (device.role !== 'member' || hub.role !== 'hub' || device.deviceId === hub.id || DeviceOriginSchema.parse(device.hubUrl) !== DeviceOriginSchema.parse(hub.url)) throw new Error('Member registration does not match its hub.');
  const token = tokenReader(homes); options.redactor.add(token());
  const material = () => { const value = readDocument(privateFile(homes, 'ui-auth.json'), UiSigningMaterialSchema); options.redactor.add(value.key); return value; }; material();
  const client = new MemberHubClient({ ...options, hubUrl: device.hubUrl, hubName: hub.name, deviceId: device.deviceId, token });
  return { device, hub, client, auth: new MemberUiAuth(client, material) };
}

/** Keeps retry identity without storing the join code; device.json is the final commit marker. */
export async function joinMember(homes: Homes, input: unknown, options: ConnectionOptions) {
  const request = MemberJoinInputSchema.parse(input);
  homes.ensure(); const ownership = new DaemonOwnership(homes);
  try {
    const deviceFile = file(homes, 'device.json'); const planFile = file(homes, 'join-pending.json');
    if (existsSync(deviceFile)) {
      const existing = memberConnection(homes, options);
      if (existing.device.hubUrl !== request.hubUrl || existing.device.url !== request.device.url) throw new Error('This home is already joined to a different device or hub.');
      await existing.client.devices();
      if (existsSync(planFile)) unlinkSync(planFile);
      return { device: existing.device, hub: existing.hub };
    }
    if (existsSync(homes.at('hub'))) throw new Error('A hub home cannot be converted into a member.');
    const pending = existsSync(planFile) ? readDocument(planFile, MemberJoinPlanSchema) : null;
    if (!pending && ['device.token', 'ui-auth.json', 'hub-device.json'].some(name => existsSync(file(homes, name)))) throw new Error('Authentication files exist without a matching join operation.');
    const plan = pending ?? writeDocument(planFile, MemberJoinPlanSchema, { schema: 'member-join-plan-v1', hubUrl: request.hubUrl, requestId: newId('join'), device: { id: newId('dev'), ...request.device } });
    if (plan.hubUrl !== request.hubUrl || stableJson(plan.device) !== stableJson({ id: plan.device.id, ...request.device })) throw new Error('A different join is pending in this home. Retry its original device settings.');
    ownership.assert();
    let hub; let authentication;
    if (existsSync(file(homes, 'device.token'))) {
      // A crash may leave the token before the remaining files. Recover with that
      // authenticated identity, including when the original join code has expired.
      const client = new MemberHubClient({ ...options, hubUrl: plan.hubUrl, hubName: plan.hubUrl, deviceId: plan.device.id, token: tokenReader(homes) });
      const roster = await client.devices();
      const member = roster.devices.find(row => row.device.id === plan.device.id && !row.revoked)?.device;
      hub = roster.devices.find(row => row.device.role === 'hub')?.device;
      if (!member || member.role !== 'member' || member.url !== plan.device.url || !hub || DeviceOriginSchema.parse(hub.url) !== plan.hubUrl) throw new HubProtocolError();
      authentication = await client.signingMaterial();
    } else {
      const result = await joinHub({ ...options, hubUrl: plan.hubUrl, hubName: plan.hubUrl }, { schema: 'join-device-v1', requestId: plan.requestId, device: plan.device, code: request.code });
      hub = result.membership.hub; authentication = result.authentication;
      ownership.assert(); atomicWrite(file(homes, 'device.token'), result.membership.token + '\n');
    }
    ownership.assert();
    writeDocument(file(homes, 'ui-auth.json'), UiSigningMaterialSchema, authentication);
    writeDocument(file(homes, 'hub-device.json'), DeviceSchema, hub);
    const device = writeDocument(deviceFile, DeviceConfigSchema, { schema: 'device-config-v1', deviceId: plan.device.id, name: plan.device.name, role: 'member', hubUrl: plan.hubUrl, url: plan.device.url, version: plan.device.version });
    unlinkSync(planFile);
    return { device, hub };
  } finally { ownership.close(); }
}
