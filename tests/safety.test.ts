import { expect, test } from 'vitest';
import { claudeBridgeToolNames, claudePermissionHook, claudeReadOnlyBridgeTools, safetyDenial, safetyReason, SAFETY_REASON, THREAD_SAFETY_REASON, COORDINATOR_SAFETY_REASON, COORDINATOR_READ_ONLY_REASON } from '../packages/runtime-contract/dist/index.js';
import { projectToolNames } from '../packages/core/dist/index.js';
import { execFileSync, spawnSync } from 'node:child_process';
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

const thread = { cwd: context.cwd, daemonPid: context.daemonPid, profile: 'thread' as const };
const codexHook = (event: string, hookContext: object) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../runtimes/codex/dist/safety-hook.js', import.meta.url)), JSON.stringify(hookContext)], { input: event, encoding: 'utf8' });
  return result.status === 0 ? { status: 0, output: JSON.parse(result.stdout) as unknown } : { status: result.status, stderr: result.stderr.split('\n').filter((line) => line && !/ExperimentalWarning|--trace-warnings/.test(line)).join('\n') };
};
const bash = (command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

test('PJ1f thread profile allows rebase and keeps every other denial', async () => {
  for (const command of ['git rebase origin/main', 'git rebase --continue', 'git rebase --abort', 'git -C . rebase -i HEAD~2']) expect(safetyDenial(command, thread)).toBeNull();
  for (const command of ['git push', 'git push origin HEAD', 'git clean -fd', 'git reset HEAD --hard', 'git branch old -D', 'git branch --delete --force old', 'jevellan restart', 'kill -9 41999', 'pkill node', 'bash -lc "git push"', 'echo "unterminated']) {
    expect(safetyDenial(command, thread)).toBe(THREAD_SAFETY_REASON);
  }
  expect(THREAD_SAFETY_REASON).toBe('Jevellan handles this. Report what you need with jevellan_thread_report.');
  expect([safetyReason({}), safetyReason({ profile: 'stretch' }), safetyReason(thread), safetyReason({ profile: 'coordinator' })]).toEqual([SAFETY_REASON, SAFETY_REASON, THREAD_SAFETY_REASON, COORDINATOR_SAFETY_REASON]);
  const hook = claudePermissionHook({ ...thread, permissions: 'write' });
  expect(await hook({ tool_name: 'Bash', tool_input: { command: 'git push' } })).toEqual(denied(THREAD_SAFETY_REASON));
  expect(await hook({ tool_name: 'Bash', tool_input: { command: 'git rebase origin/main' } })).toEqual({});
  expect(await hook({ tool_name: 'Bash', tool_input: {} })).toEqual(denied(THREAD_SAFETY_REASON));
  expect(await hook({ tool_name: 'Write' })).toEqual({});
  expect(codexHook(bash('git push'), thread)).toEqual({ status: 0, output: denied(THREAD_SAFETY_REASON) });
  expect(codexHook(bash('git rebase origin/main'), thread)).toEqual({ status: 0, output: {} });
  expect(codexHook('not an event', thread)).toEqual({ status: 2, stderr: THREAD_SAFETY_REASON });
  const coordinator = { ...thread, profile: 'coordinator' };
  for (const command of ['git push', 'git rebase origin/main']) expect(codexHook(bash(command), coordinator)).toEqual({ status: 0, output: denied(COORDINATOR_SAFETY_REASON) });
  // A stretch context without its action still fails closed with the stretch reason.
  expect(codexHook(bash('git push'), { cwd: context.cwd, daemonPid: context.daemonPid })).toEqual({ status: 0, output: denied(SAFETY_REASON) });
  expect(codexHook(bash('git push'), { cwd: context.cwd })).toEqual({ status: 2, stderr: SAFETY_REASON });
});

test('the coordinator hook is read-only and allows exactly its scope tools', async () => {
  const bridgeTools = claudeBridgeToolNames(projectToolNames({ kind: 'coordinator' }));
  expect(bridgeTools).toContain('mcp__jevellan__jevellan_thread_start');
  expect(bridgeTools).not.toContain('mcp__jevellan__jevellan_mail_send');
  const hook = claudePermissionHook({ cwd: context.cwd, daemonPid: context.daemonPid, profile: 'coordinator', permissions: 'read-only', bridgeTools });
  for (const tool of bridgeTools) expect(await hook({ tool_name: tool })).toEqual({});
  for (const tool of ['Read', 'Glob', 'Grep']) expect(await hook({ tool_name: tool })).toEqual({});
  for (const tool of ['Write', 'Edit', 'Bash', 'mcp__jevellan__jevellan_handoff', 'mcp__jevellan__memory_write', 'mcp__jevellan__jevellan_thread_report']) {
    expect(await hook({ tool_name: tool, tool_input: { command: 'git status' } })).toEqual(denied(COORDINATOR_READ_ONLY_REASON));
  }
});
