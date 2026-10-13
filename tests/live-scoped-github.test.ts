import { expect, test, vi } from 'vitest';
import * as setup from '../scripts/live/setup.mjs';
import { github } from '../scripts/live/client.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const token = 'fixture-scoped-credential';
const project = { id: 'sandbox_new', remoteUrl: 'https://github.com/gongiskhan/jevellan-live-sandbox.git', githubTokenScope: 'project' };
test('the GitHub CLI repository lookup uses the actual repository endpoint without a trailing slash', () => {
  const bin = mkdtempSync(join(tmpdir(), 'jevellan-gh-arguments-'));
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
  try {
    expect(github('')).toEqual(['api', 'repos/gongiskhan/jevellan-live-sandbox', '--method', 'GET']);
    expect(github('actions/workflows')).toEqual(['api', 'repos/gongiskhan/jevellan-live-sandbox/actions/workflows', '--method', 'GET']);
  } finally { vi.unstubAllEnvs(); rmSync(bin, { recursive: true, force: true }); }
});
function client() {
  return { config: { proDeviceId: 'pro', madridDeviceId: 'madrid', projectId: 'sandbox_seed', githubTokenScope: 'project' },
    call: vi.fn(async (_method: string, path: string) => {
      if (path === '/hub/config') return { configuration: { 'x-jevellan': { menu: ['claude', 'codex'].map(runtime => ({ runtime, model: runtime === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol', enabled: true, efforts: ['high'] })), decisions: { model: 'jev' } } } };
      if (path === '/hub/accounts') return { accounts: ['claude', 'codex'].map(runtime => ({ account: { runtime }, statuses: ['pro', 'madrid'].map(deviceId => ({ deviceId, auth: 'ready' })) })) };
      if (path === '/hub/devices/roster') return { devices: ['pro', 'madrid'].map(id => ({ device: { id }, status: 'online', revoked: false })) };
      if (path === '/hub/secrets/github?projectId=sandbox_seed') return { saved: true };
      throw new Error(`Unexpected request ${path}`);
    }) };
}
test('scoped live preflight reads only the explicitly selected project summary and keeps the shared default unused', async () => {
  const owner = client();
  const result = await setup.preflight(owner, 'claude', { githubToken: token, jevKey: 'fixture-jev', visionToken: 'fixture-vision' }, () => ({ full_name: 'gongiskhan/jevellan-live-sandbox' }));
  expect(result.gaps).toEqual([]);
  expect(owner.call.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  expect(owner.call.mock.calls.map(([, path]) => path)).not.toContain('/hub/secrets/github');
});
test('scoped reset readiness requires the ephemeral credential even when its source summary is saved', async () => {
  const owner = client();
  const result = await setup.preflight(owner, 'claude', { jevKey: 'fixture-jev', visionToken: 'fixture-vision' }, () => ({ full_name: 'gongiskhan/jevellan-live-sandbox' }));
  expect(result.gaps).toContain('The private runner needs the approved sandbox project credential for fresh project-scoped resets.');
});
test('a missing scoped credential blocks before checkout resets, cancellation or project writes', async () => {
  const owner = client();
  await expect(setup.resetSandbox(owner, {}, 'claude', {}, {})).rejects.toThrow('approved sandbox project credential');
  expect(owner.call).not.toHaveBeenCalled();
});
test('a fresh sandbox registration saves its credential through the owner API before any session setup', async () => {
  const call = vi.fn(async () => ({ saved: true }));
  await setup.registerSandboxProject({ call }, project, { githubToken: token });
  expect(call.mock.calls).toEqual([
    ['PUT', '/hub/projects', expect.objectContaining({ schema: 'project-write-v1', revision: 0, project })],
    ['PUT', '/hub/secrets/github?projectId=sandbox_new', expect.objectContaining({ schema: 'save-secret-v1', value: token })],
  ]);
});
test('missing scoped credentials and a foreign repository refuse registration before any owner mutation', async () => {
  const call = vi.fn();
  await expect(setup.registerSandboxProject({ call }, project, {})).rejects.toThrow('approved sandbox project credential');
  await expect(setup.registerSandboxProject({ call }, { ...project, remoteUrl: 'https://github.com/gongiskhan/ekoa-code.git' }, { githubToken: token })).rejects.toThrow('disposable sandbox');
  expect(call).not.toHaveBeenCalled();
});
test('legacy shared registrations keep their existing credential choice and never save a default credential', async () => {
  const call = vi.fn(async () => ({}));
  await setup.registerSandboxProject({ call }, { ...project, githubTokenScope: 'shared' }, {});
  expect(call).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledWith('PUT', '/hub/projects', expect.objectContaining({ project: { ...project, githubTokenScope: 'shared' } }));
});
