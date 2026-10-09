import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccountHubRequestSchema, ConsumeSwitchSchema, DeviceSwitchInputSchema, EmptySchema, MeshSessionInputSchema, MeshSessionResultSchema, PassphraseInputSchema, PeerSessionInputSchema, ProjectHubCollectionSchema, ProjectHubRequestSchema, collectionOf, isProjectHubRead } from '@jevellan/core';
import { HubAccounts, HubCheckoutStore, HubIndexes, HubPublicationLeases, sessionCookie } from '@jevellan/mesh';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { SharedStateRequestSchema, boundedRedaction } from '@jevellan/core';
import { HubProjectStore, HubState } from '@jevellan/mesh';
import { ImproverDeviceRequestSchema, ImproverRequestSchema, PeerLoginSessionInputSchema } from '@jevellan/core';
import { AgentAccessHubRequestSchema } from '@jevellan/core';

/** Project hub collections; `handleApi` leaves them to this route's own lifecycle gate (D247). */
export const PROJECT_HUB_ROUTE = /^\/hub\/mesh\/projects\/([a-z]+)$/;
export async function handleMeshDeviceApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname; if (!path.startsWith('/hub/mesh/')) return false;
  if (app.device.role !== 'hub') throw Object.assign(new Error('This endpoint belongs to the hub.'), { status: 404 });
  // These endpoints exchange device credentials, not browser Settings data.
  if (request.headers.origin || request.headers['sec-fetch-site']) throw Object.assign(new Error('Use the device connection for this request.'), { status: 403 });
  const method = request.method ?? 'GET';
  if (path === '/hub/mesh/join' && method === 'POST') {
    json(response, app.mesh.join(await requestBody(request), request.socket.remoteAddress ?? 'unknown'), 201); return true;
  }
  const authorization = request.headers.authorization;
  const device = app.devices.authenticate(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined);
  const send = (value: unknown) => json(response, app.hub.redactor.document(value));
  if (path === '/hub/mesh/agent-access' && method === 'POST') {
    const input = AgentAccessHubRequestSchema.parse(await requestBody(request)); app.devices.authenticate(authorization!.slice(7));
    const release = ['create', 'revoke', 'mail-send'].includes(input.operation) ? app.lifecycle.enter({ kind: 'request' }) : undefined;
    try {
      const result = app.hubAgentAccess!.request(input, device.id, app.hubAuth);
      // Creation is the one response that returns an agent token, exactly once; every later view is a summary.
      if (result.schema === 'agent-access-created-v1') json(response, { ...result, connection: app.redactor.document(result.connection) });
      else send(result);
    } finally { release?.(); }
    return true;
  }
  if (path === '/hub/mesh/improver' && method === 'POST') {
    const input = ImproverRequestSchema.parse(await requestBody(request)); await app.routingImprover!.revisions.ready;
    app.devices.authenticate(authorization!.slice(7));
    const result = await app.routingImprover!.request(input, device.id);
    app.devices.authenticate(authorization!.slice(7)); send(result); return true;
  }
  if (path === '/hub/mesh/improver-device' && method === 'POST') {
    const input = ImproverDeviceRequestSchema.parse(await requestBody(request)); await app.improver!.revisions.ready;
    app.devices.authenticate(authorization!.slice(7));
    const result = app.improver!.projects.request(device.id, input);
    app.devices.authenticate(authorization!.slice(7)); send(result); return true;
  }
  if (path === '/hub/mesh/state' && method === 'POST') {
    const input = SharedStateRequestSchema.parse(await requestBody(request)); app.devices.authenticate(authorization!.slice(7));
    const result = await new HubState(app.hub, device.id, 'runtimes' in input ? input.runtimes : [...app.runtimes.keys()]).request(input);
    app.devices.authenticate(authorization!.slice(7));
    // Credential replies bypass redaction, which would otherwise replace the token (GitHub tokens also match a pattern).
    if (input.operation === 'jev-credential' || input.operation === 'github-credential') json(response, result); else send(result); return true;
  }
  const projects = path.match(PROJECT_HUB_ROUTE);
  if (projects && method === 'POST') {
    const collection = ProjectHubCollectionSchema.safeParse(projects[1]); if (!collection.success) throw Object.assign(new Error('Not found.'), { status: 404 });
    const input = ProjectHubRequestSchema.parse(await requestBody(request));
    if (collectionOf(input.operation) !== collection.data) throw Object.assign(new Error('This operation belongs to another project collection.'), { status: 400 });
    // Reads change nothing and are admitted like GET requests; writes are refused while an installer holds maintenance.
    const release = isProjectHubRead(input.operation) ? undefined : app.lifecycle.enter({ kind: 'request' });
    try {
      app.devices.authenticate(authorization!.slice(7));
      const result = new HubProjectStore(app.hub, device.id, undefined, () => app.devices.list()).request(input);
      // Redaction never lengthens a text past the maximum its schema checked, so members read every reply (P8 review S-1).
      app.devices.authenticate(authorization!.slice(7)); json(response, boundedRedaction(app.hub.redactor, result));
      // An envelope for the hub itself is processed now instead of at the next inbox poll (D40); a retry notifies again.
      if (input.operation === 'envelope-put' && input.envelope.targetDeviceId === app.device.deviceId) app.projectWork.relayArrived();
      return true;
    } finally { release?.(); }
  }
  if (path === '/hub/mesh/indexes' && method === 'POST') {
    const input = await requestBody(request); app.devices.authenticate(authorization!.slice(7));
    send(new HubIndexes(app.hub, device.id).request(input)); return true;
  }
  if ((path === '/hub/mesh/checkout' || path === '/hub/mesh/publication') && method === 'POST') {
    const input = await requestBody(request); app.devices.authenticate(authorization!.slice(7));
    const result = path === '/hub/mesh/checkout' ? new HubCheckoutStore(app.hub, device.id).request(input) : await new HubPublicationLeases(app.hub, device.id).request(input);
    app.devices.authenticate(authorization!.slice(7)); send(result); return true;
  }
  if (path === '/hub/mesh/accounts' && method === 'POST') {
    const input = AccountHubRequestSchema.parse(await requestBody(request)); app.devices.authenticate(authorization!.slice(7));
    const result = new HubAccounts(app.hub, device.id).request(input);
    if (input.operation === 'credential') json(response, result); else send(result);
    return true;
  }
  if (path === '/hub/mesh/devices' && method === 'GET') { send(app.mesh.roster(device.id)); return true; }
  if (path === '/hub/mesh/heartbeat' && method === 'POST') { send(app.devices.heartbeat(device.id, await requestBody(request))); return true; }
  if (path === '/hub/mesh/invitations' && method === 'POST') { EmptySchema.parse(await requestBody(request)); json(response, app.mesh.invite()); return true; }
  if (path === '/hub/mesh/auth/material' && method === 'GET') { json(response, app.hubAuth.signingMaterial()); return true; }
  if (path === '/hub/mesh/auth/check' && method === 'POST') {
    const input = MeshSessionInputSchema.parse(await requestBody(request)); send(app.mesh.session(device.id, input.token)); return true;
  }
  if (path === '/hub/mesh/auth/peer-check' && method === 'POST') {
    const input = PeerSessionInputSchema.parse(await requestBody(request)); app.devices.authenticate(authorization!.slice(7));
    send(app.mesh.peerSession(device.id, input)); return true;
  }
  if (path === '/hub/mesh/auth/peer-login-check' && method === 'POST') {
    const input = PeerLoginSessionInputSchema.parse(await requestBody(request)); app.devices.authenticate(authorization!.slice(7));
    send(app.mesh.peerLoginSession(device.id, input)); return true;
  }
  if (path === '/hub/mesh/auth/login' && method === 'POST') {
    const input = PassphraseInputSchema.parse(await requestBody(request));
    const token = await app.hubAuth.login(input, `device:${device.id}`, device.id);
    // Scrypt yields: recheck authorization before returning a newly issued session.
    app.devices.authenticate(authorization!.slice(7));
    json(response, MeshSessionResultSchema.parse({ schema: 'mesh-session-result-v1', token })); return true;
  }
  if (path === '/hub/mesh/auth/logout' && method === 'POST') {
    const input = MeshSessionInputSchema.parse(await requestBody(request)); app.hubAuth.logout(input.token ?? undefined, device.id);
    send(app.mesh.session(device.id, null)); return true;
  }
  if (path === '/hub/mesh/switch' && method === 'POST') {
    json(response, app.devices.issueSwitch(device.id, DeviceSwitchInputSchema.parse(await requestBody(request)))); return true;
  }
  if (path === '/hub/mesh/switch/consume' && method === 'POST') {
    const input = ConsumeSwitchSchema.parse(await requestBody(request)); json(response, app.mesh.consumeSwitch(device.id, input.token)); return true;
  }
  throw Object.assign(new Error('Not found.'), { status: 404 });
}

/** Called after browser authentication, except for the expiring switch-token exchange. */
export async function handleMeshUiApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, secureCookies = false): Promise<boolean> {
  const method = request.method ?? 'GET'; const path = url.pathname;
  if (path === '/hub/devices/roster' && method === 'GET') { json(response, app.redactor.document(await app.roster())); return true; }
  if (path === '/hub/devices/invitations' && method === 'POST') { EmptySchema.parse(await requestBody(request)); json(response, await app.inviteDevice()); return true; }
  if (path === '/api/devices/switch' && method === 'POST') { json(response, await app.switchDevice(await requestBody(request))); return true; }
  if (path === '/switch' && method === 'GET') {
    response.setHeader('Referrer-Policy', 'no-referrer');
    const input = ConsumeSwitchSchema.parse({ schema: 'consume-switch-v1', token: url.searchParams.get('token') });
    const result = await app.consumeSwitch(input);
    response.writeHead(303, { 'Set-Cookie': sessionCookie(result.token, secureCookies), Location: result.receipt.route, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end(); return true;
  }
  return false;
}
