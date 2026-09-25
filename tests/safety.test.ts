import { expect, test } from 'vitest';
import { claudePermissionHook, claudeReadOnlyBridgeTools, safetyDenial, SAFETY_REASON } from '../packages/runtime-contract/dist/index.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const context = { cwd: '/private/tmp/jevellan-fixture', action: 'implement', daemonPid: 41999 };
test.each([
  'git push', 'git -C . push origin main', '/usr/bin/git push --force', 'git rebase origin/main',
  'git reset HEAD --hard', 'git clean -fd', 'git branch old -D', 'git branch --delete old --force',
  'gh repo edit owner/repo --visibility public', 'gh repo delete owner/repo', 'gh api repos/a/b -f private=true',
  'jevellan stop', 'jevellan restart', 'jevellan update', 'jevellan uninstall', 'jevellan install', 'jevellan rollback', 'jevellan join',
  'node /tmp/distribution/bin/jevellan.mjs install', 'npx --yes github:gongiskhan/jevellan update', 'npm exec -- jevellan rollback',
  'launchctl kickstart -k gui/501/dev.jevellan.daemon', 'systemctl --user restart jevellan.service',
  'kill -9 41999', 'sudo pkill -f "node.*jevellan"', 'npm test && git push',
  'env NAME=value command git push', 'bash -lc "git push"', 'rm -rf ../outside', 'rm --force --recursive /outside',
])('Safety denies the promised ordinary form: %s', (command) => {
  expect(safetyDenial(command, context)).toBe(SAFETY_REASON);
});

test.each(['npm test', 'git diff HEAD', 'git status --short', 'kill -9 41998', 'rg "git push" docs/', 'rm -rf build', 'jevellan doctor', 'jevellan status', 'jevellan --version'])('Safety leaves unrelated commands available: %s', (command) => {
  expect(safetyDenial(command, context)).toBeNull();
});

test('only integration may rebase', () => {
  expect(safetyDenial('git rebase origin/main', { ...context, action: 'integrate' })).toBeNull();
  expect(safetyDenial('git push', { ...context, action: 'integrate' })).toBe(SAFETY_REASON);
});

test('the actual Claude hook denies file tools and all shell calls in read-only mode', async () => {
  const hook = claudePermissionHook({ ...context, permissions: 'read-only', memoryWrite: false });
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Agent', 'mcp__jevellan__memory_write', 'mcp__other__write']) {
    expect(await hook({ tool_name: tool, tool_input: { command: 'printf changed > file' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  }
  expect(await hook({ tool_name: 'Read' })).toEqual({});
  expect(await hook({ tool_name: 'ToolSearch', tool_input: { query: 'select:Glob,Grep,mcp__jevellan__jevellan_handoff' } })).toEqual({});
  expect(await hook({ tool_name: 'Glob', tool_input: { pattern: '**/*' } })).toEqual({});
  for (const tool of ['jevellan_handoff', 'jevellan_finding', 'jevellan_conversation_search', 'jevellan_conversation_read', 'memory_search', 'memory_read', 'memory_propose']) {
    expect(claudeReadOnlyBridgeTools(false)).toContain(`mcp__jevellan__${tool}`);
    expect(await hook({ tool_name: `mcp__jevellan__${tool}` })).toEqual({});
  }
  for (const tool of ['mcp__other__jevellan_handoff', 'mcp__jevellan__jevellan_handoff_extra', 'mcp__jevellan__memory_edit']) {
    expect(claudeReadOnlyBridgeTools(false)).not.toContain(tool);
    expect(await hook({ tool_name: tool })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  }
  const remember = claudePermissionHook({ ...context, permissions: 'read-only', memoryWrite: true });
  expect(claudeReadOnlyBridgeTools(true)).toContain('mcp__jevellan__memory_write');
  expect(await remember({ tool_name: 'mcp__jevellan__memory_write' })).toEqual({});
  expect(await remember({ tool_name: 'Edit' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});

test('the writing hook still enforces Safety', async () => {
  const hook = claudePermissionHook({ ...context, permissions: 'write', memoryWrite: true });
  expect(await hook({ tool_name: 'Bash', tool_input: { command: 'kill -9 41999' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(await hook({ tool_name: 'Edit' })).toEqual({});
});

test('Codex hook executable refuses reordered commands and permits rebase only in integration', () => {
  const hook = fileURLToPath(new URL('../runtimes/codex/dist/safety-hook.js', import.meta.url));
  const call = (command: string, action = 'implement') => JSON.parse(execFileSync(process.execPath, [hook, JSON.stringify({ ...context, action })], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' }));
  for (const command of ['git -C . push origin main', 'git reset HEAD --hard', 'git branch old -D', 'rm -r -f /outside', 'gh repo edit owner/repo --visibility public', 'jevellan restart', 'kill -9 41999', 'git rebase origin/main']) expect(call(command)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: SAFETY_REASON } });
  expect(call('git rebase origin/main', 'integrate')).toEqual({});
  expect(call('git push', 'integrate')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});
