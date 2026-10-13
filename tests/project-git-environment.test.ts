import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretRedactor } from '../packages/core/dist/index.js';
import { GitHubAccess } from '../packages/projects/dist/index.js';
import { launchEnvironment } from '../packages/runtime-contract/dist/index.js';
import { AccountSchema } from '../packages/core/dist/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test.each(['https://github.com/owner/private.git', 'https://github.com/owner/private', 'git@github.com:owner/private.git', 'ssh://git@github.com/owner/private'])('turn Git authentication applies to the registered remote only (%s)', async remote => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-git-env-')); roots.push(root);
  const config = join(root, '.gitconfig'); writeFileSync(config, '[user]\n\tname = Unchanged owner\n');
  const before = readFileSync(config); const redactor = new SecretRedactor(); const calls: Array<string | undefined> = [];
  const access = new GitHubAccess({ credential: async projectId => { calls.push(projectId); return 'ephemeral-test-value'; }, redactor });
  const env = await access.turnGitEnvironment('project_a', remote);
  const url = remote.startsWith('https://') ? remote : 'https://github.com/owner/private.git';
  const header = execFileSync('git', ['config', '--get-urlmatch', 'http.extraheader', url], { env: { ...process.env, HOME: root, ...env }, encoding: 'utf8' }).trim();
  expect(header).toBe('Authorization: Basic ' + Buffer.from('x-access-token:ephemeral-test-value').toString('base64'));
  for (const other of ['https://github.com/owner/private-other.git', 'https://github.com/owner/other.git', 'https://example.com/owner/private.git']) {
    expect(() => execFileSync('git', ['config', '--get-urlmatch', 'http.extraheader', other], { env: { ...process.env, HOME: root, ...env }, stdio: 'pipe' })).toThrow();
  }
  expect(calls).toEqual(['project_a']); expect(readFileSync(config)).toEqual(before);
  expect(env.HOME).toBeUndefined(); expect(redactor.text(header)).not.toContain('Basic');
});

test('turn credentials are refreshed, omitted when absent, and never read for a non-GitHub or credential-bearing remote', async () => {
  let token: string | undefined = 'first-ephemeral-value'; const calls: Array<string | undefined> = [];
  const access = new GitHubAccess({ credential: async projectId => { calls.push(projectId); return token; }, redactor: new SecretRedactor() });
  const first = await access.turnGitEnvironment('project_a', 'https://github.com/owner/private.git');
  token = 'rotated-ephemeral-value'; const second = await access.turnGitEnvironment('project_a', 'https://github.com/owner/private.git');
  expect(first.GIT_CONFIG_VALUE_0).not.toBe(second.GIT_CONFIG_VALUE_0);
  token = undefined; expect(await access.turnGitEnvironment('project_a', 'https://github.com/owner/private.git')).toEqual({});
  for (const remote of ['https://example.com/owner/private.git', 'https://user:secret@github.com/owner/private.git', '/tmp/local.git']) expect(await access.turnGitEnvironment('project_a', remote)).toEqual({});
  expect(calls).toEqual(['project_a', 'project_a', 'project_a']);
});

test.each(['claude', 'codex'] as const)('the %s native worker retains explicit turn Git authentication while keeping its isolated home', async runtime => {
  const access = new GitHubAccess({ credential: async () => 'ephemeral-test-value', redactor: new SecretRedactor() });
  const env = await access.turnGitEnvironment('project_a', 'git@github.com:owner/private.git');
  const home = '/tmp/isolated-account';
  const launched = launchEnvironment(runtime, { account: { home, account: AccountSchema.parse({ schema: 'account-v1', id: 'account_a', runtime, kind: 'subscription', label: 'Fixture', enabled: true, credential: 'per-device' }), env: {} },
    launch: { env, mcpServers: {} } });
  expect(launched.GIT_CONFIG_VALUE_0).toBe(env.GIT_CONFIG_VALUE_0);
  expect(launched.GIT_CONFIG_VALUE_1).toBe('git@github.com:owner/private.git');
  expect(launched.HOME).toBe(home);
});
