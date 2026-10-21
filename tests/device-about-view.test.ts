import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const commands = { schema: 'installation-commands-v1', update: 'jevellan update', uninstall: 'jevellan uninstall' };

test('About reads the exact local device version and maintenance command text without starting work', async () => {
  const f = fixture = await projectFixture(), response = await f.request('/api/config/about'); expect(response.status).toBe(200);
  const version = (await f.app.roster()).devices.find(row => row.device.id === f.app.device.deviceId)?.device.version ?? null;
  expect(await response.json()).toMatchObject({ schema: 'device-about-view-v1', currentDeviceId: f.app.device.deviceId, currentVersion: version, commands });
  expect(f.fake.runs).toHaveLength(0);
});

test('About on a member and its normal tool forwarder identifies the member device', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), response = await member.request('/api/config/about'); expect(response.status).toBe(200);
  const view = await response.json(); expect(view).toMatchObject({ schema: 'device-about-view-v1', currentDeviceId: member.deviceId, commands });
  const reply = await member.app.member!.ownerTool({ schema: 'owner-tool-forward-v1', name: 'config', request: { schema: 'owner-tool-request-v1', action: 'about', args: {}, project: 'project', caller: 'session:fixture-about' } });
  expect(reply).toMatchObject({ ok: true, data: view }); expect(f.fake.runs).toHaveLength(0); expect(member.fake.runs).toHaveLength(0);
});

test('About engine selects by identity and reports an absent device version as unknown', async () => {
  const f = fixture = await projectFixture(), service = await import('../packages/mesh/dist/index.js');
  expect(service).toHaveProperty('deviceAboutView');
  const roster = await f.app.roster(), first = roster.devices[0]!;
  const offered = { ...roster, devices: [{ ...first, device: { ...first.device, id: 'device_first', version: 'fixture-first-version' } }, { ...first, device: { ...first.device, id: 'device_second', version: 'fixture-second-version' } }] };
  expect(service.deviceAboutView(offered, 'device_second')).toMatchObject({ currentDeviceId: 'device_second', currentVersion: 'fixture-second-version', commands });
  expect(service.deviceAboutView(offered, 'device_missing')).toMatchObject({ currentDeviceId: 'device_missing', currentVersion: null });
});
