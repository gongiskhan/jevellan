import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { Homes, SecretRedactor, nativeSetup } from '../packages/core/dist/index.js';
let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'jevellan-native-setup-')); const user = join(root, 'user'); mkdirSync(user);
  const homes = new Homes(join(root, 'home'), user), native = join(user, '.claude'); mkdirSync(native);
  return { homes, native, account: homes.account('claude', 'fixture') };
}
function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => { for (const file of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, file.name); if (file.isDirectory()) walk(path); else result[path.slice(root.length)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  } }; walk(root); return result;
}
test('native reads refresh each turn, preserve native bytes and isolate settings, skills and MCP credentials', () => {
  const f = fixture(), token = 'native-mcp-fixture-private-value';
  writeFileSync(join(f.native, 'CLAUDE.md'), `Native rules\nDo not disclose ${token}`);
  writeFileSync(join(f.native, 'settings.json'), JSON.stringify({ language: 'Portuguese', permissions: { defaultMode: 'bypassPermissions' }, model: 'native-model', apiKeyHelper: 'native-auth', env: { ANTHROPIC_API_KEY: token } }));
  mkdirSync(join(f.native, 'skills', 'say-hello'), { recursive: true }); writeFileSync(join(f.native, 'skills', 'say-hello', 'SKILL.md'), '---\nname: say-hello\ndescription: Say hello\n---\nHello');
  writeFileSync(join(f.homes.userHome, '.claude.json'), JSON.stringify({ mcpServers: { fixture: { command: 'fixture-server', env: { FIXTURE_TOKEN: token } } } }));
  const before = files(f.homes.userHome), redactor = new SecretRedactor();
  const one = nativeSetup(f.homes, 'claude', f.account, true, redactor);
  expect(one.launch.instructions).toBe('Native rules\nDo not disclose [redacted]'); expect(one.launch.settings).toEqual({ language: 'Portuguese' });
  expect(one.launch.plugins).toHaveLength(1); expect(one.mcp[0]?.env.FIXTURE_TOKEN).toBe(token);
  expect(redactor.text(token)).toBe('[redacted]'); expect(JSON.stringify(one.launch)).not.toContain(token);
  expect(files(f.homes.userHome)).toEqual(before);
  for (const path of Object.keys(files(f.homes.root))) expect(readFileSync(join(f.homes.root, path))).not.toContain(Buffer.from(token));
  writeFileSync(join(f.native, 'skills', 'say-hello', 'SKILL.md'), 'Changed native skill');
  const changed = files(f.homes.userHome), two = nativeSetup(f.homes, 'claude', f.account);
  expect(two.launch.plugins[0]).not.toBe(one.launch.plugins[0]);
  expect(readFileSync(join(two.launch.plugins[0]!, 'skills', 'say-hello', 'SKILL.md'), 'utf8')).toBe('Changed native skill');
  expect(readFileSync(join(one.launch.plugins[0]!, 'skills', 'say-hello', 'SKILL.md'), 'utf8')).toContain('Hello');
  expect(files(f.homes.userHome)).toEqual(changed);
  expect(nativeSetup(f.homes, 'claude', f.account, false).launch).toEqual({ schema: 'native-launch-setup-v1', instructions: '', settings: {}, plugins: [] });
});
test('native Codex configuration cannot select authentication, model, permissions or a provider', () => {
  const f = fixture(); const native = join(f.homes.userHome, '.codex'); mkdirSync(native);
  writeFileSync(join(native, 'config.toml'), 'model="native"\nmodel_provider="private"\nsandbox_mode="danger-full-access"\napproval_policy="never"\npersonality="pragmatic"\n');
  writeFileSync(join(native, 'AGENTS.md'), 'Codex native instructions');
  const before = files(f.homes.userHome), setup = nativeSetup(f.homes, 'codex', f.homes.account('codex', 'fixture'));
  expect(setup.launch.settings).toEqual({ personality: 'pragmatic' }); expect(setup.launch.instructions).toBe('Codex native instructions');
  expect(files(f.homes.userHome)).toEqual(before);
});
test('native environment authentication is ephemeral and unsupported or unavailable servers are not applied', () => {
  const f = fixture(), variable = 'JEVELLAN_NATIVE_FIXTURE_TOKEN';
  // Explicit MCP variables use their own names; Jevellan and provider variables remain protected.
  const key = 'NATIVE_FIXTURE_MCP_TOKEN'; process.env[key] = 'fixture-mcp-ephemeral-auth';
  try {
    writeFileSync(join(f.homes.userHome, '.claude.json'), JSON.stringify({ mcpServers: {
      expanded: { type: 'http', url: '${NATIVE_FIXTURE_BASE:-https://example.invalid}/mcp', headers: { Authorization: `Bearer \${${key}}` } },
      missing: { command: 'fixture', env: { TOKEN: '${NATIVE_FIXTURE_MISSING}' } },
      protected: { command: 'fixture', env: { TOKEN: `\${${variable}:-default}` } },
      unsupported: { type: 'http', url: 'https://example.invalid/mcp', headersHelper: 'native-helper' }
    } }));
    const before = files(f.homes.userHome), claude = nativeSetup(f.homes, 'claude', f.account);
    expect(claude.mcp).toHaveLength(1); expect(claude.mcp[0]?.headers?.Authorization).toBe(`Bearer ${process.env[key]}`);
    expect(JSON.stringify(claude.launch)).not.toContain(process.env[key]); expect(claude.inventory.items.filter(item => item.item.startsWith('MCP ') && !item.applied)).toHaveLength(3);
    const native = join(f.homes.userHome, '.codex'); mkdirSync(native);
    writeFileSync(join(native, 'config.toml'), `[mcp_servers.http]\nurl="https://example.invalid/mcp"\nenv_http_headers={Authorization="${key}"}\n[mcp_servers.stdio]\ncommand="fixture"\nenv_vars=["${key}"]\n`);
    const codexBefore = files(f.homes.userHome), codex = nativeSetup(f.homes, 'codex', f.homes.account('codex', 'fixture'));
    expect(codex.mcp[0]?.headers?.Authorization).toBe(process.env[key]); expect(codex.mcp[1]?.env[key]).toBe(process.env[key]);
    expect(files(f.homes.userHome)).toEqual(codexBefore); expect(Object.entries(before).every(([path, digest]) => codexBefore[path] === digest)).toBe(true);
  } finally { delete process.env[key]; }
});
test('removed and disabled native Codex prompts are withdrawn without changing account-owned prompts', () => {
  const f = fixture(), native = join(f.homes.userHome, '.codex'), account = f.homes.account('codex', 'fixture');
  mkdirSync(join(native, 'prompts'), { recursive: true }); writeFileSync(join(native, 'prompts', 'hello.md'), 'Hello');
  mkdirSync(join(account, 'prompts'), { recursive: true }); writeFileSync(join(account, 'prompts', 'owned.md'), 'Account prompt');
  nativeSetup(f.homes, 'codex', account); expect(readdirSync(join(account, 'prompts'))).toHaveLength(2);
  rmSync(join(native, 'prompts'), { recursive: true }); nativeSetup(f.homes, 'codex', account); expect(readdirSync(join(account, 'prompts'))).toEqual(['owned.md']);
  mkdirSync(join(native, 'prompts')); writeFileSync(join(native, 'prompts', 'hello.md'), 'Hello'); nativeSetup(f.homes, 'codex', account);
  nativeSetup(f.homes, 'codex', account, false); expect(readdirSync(join(account, 'prompts'))).toEqual(['owned.md']);
});
