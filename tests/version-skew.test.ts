import { afterEach, expect, test } from 'vitest';
import { DeviceRosterSchema, VERSION, compareVersions, versionSkewMessage } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('versions compare by major, minor and patch', () => {
  expect(compareVersions('0.3.10', '0.3.9')).toBeGreaterThan(0); expect(compareVersions('0.4.0', '0.3.99')).toBeGreaterThan(0);
  expect(compareVersions('0.3.6', '0.3.6')).toBe(0); expect(compareVersions('0.3.2', '0.3.4')).toBeLessThan(0);
});

test('a member learns the hub version from its heartbeat; a newer member refuses new work and an older one keeps working', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  const newer = await projectMember(f, { name: 'Newer member', version: '99.0.0' });
  expect(newer.app.member?.hubVersion).toBe(VERSION);
  const message = versionSkewMessage('99.0.0', VERSION);
  expect(message).toBe(`This device runs 99.0.0. The hub runs ${VERSION}. Update this device with \`jevellan update\`.`);
  expect(newer.app.versionRefusal()).toBe(message);
  await expect(newer.app.projectWork.threads.start({ projectId: f.project.id, title: 'New work', task: 'Start it.', createdBy: 'owner' } as never)).rejects.toMatchObject({ message, status: 409 });

  const older = await projectMember(f, { name: 'Older member', version: '0.0.1' });
  expect(older.app.member?.hubVersion).toBe(VERSION); expect(older.app.versionRefusal()).toBeUndefined();
  // The roster each browser reads carries both versions, which is what the banner compares.
  const roster = await older.json('/hub/devices/roster', DeviceRosterSchema);
  expect(roster.devices.find(row => row.device.id === roster.currentDeviceId)?.device.version).toBe('0.0.1');
  expect(roster.devices.find(row => row.device.role === 'hub')?.device.version).toBe(VERSION);
});
