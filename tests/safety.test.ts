import { expect, test } from 'vitest';
import { claudePermissionHook, safetyDenial, SAFETY_REASON } from '../packages/runtime-contract/dist/index.js';

const context = { cwd: '/private/tmp/jevellan-fixture', action: 'implement', daemonPid: 41999 };
test.each([
  'git push', 'git -C . push origin main', '/usr/bin/git push --force', 'git rebase origin/main',
  'git reset HEAD --hard', 'git clean -fd', 'git branch old -D', 'git branch --delete old --force',
  'gh repo edit owner/repo --visibility public', 'gh repo delete owner/repo', 'gh api repos/a/b -f private=true',
  'jevellan stop', 'jevellan restart', 'jevellan update', 'jevellan uninstall',
  'launchctl kickstart -k gui/501/dev.jevellan.daemon', 'systemctl --user restart jevellan.service',
  'kill -9 41999', 'sudo pkill -f "node.*jevellan"', 'npm test && git push',
  'env NAME=value command git push', 'bash -lc "git push"', 'rm -rf ../outside', 'rm --force --recursive /outside',
])('Safety denies the promised ordinary form: %s', (command) => {
  expect(safetyDenial(command, context)).toBe(SAFETY_REASON);
});

test.each(['npm test', 'git diff HEAD', 'git status --short', 'kill -9 41998', 'rg "git push" docs/', 'rm -rf build'])('Safety leaves unrelated commands available: %s', (command) => {
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
  expect(await hook({ tool_name: 'mcp__jevellan__memory_propose' })).toEqual({});
  const remember = claudePermissionHook({ ...context, permissions: 'read-only', memoryWrite: true });
  expect(await remember({ tool_name: 'mcp__jevellan__memory_write' })).toEqual({});
  expect(await remember({ tool_name: 'Edit' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});

test('the writing hook still enforces Safety', async () => {
  const hook = claudePermissionHook({ ...context, permissions: 'write', memoryWrite: true });
  expect(await hook({ tool_name: 'Bash', tool_input: { command: 'kill -9 41999' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(await hook({ tool_name: 'Edit' })).toEqual({});
});
