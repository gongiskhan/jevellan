import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { Homes, AccountSchema, RiggingDelivery, RiggingItemSchema, projectMemoryHooks } from '../../packages/core/dist/index.js';
import { CodexControl } from '../../runtimes/codex/dist/control.js';
import { projectTrustOverride } from '../../runtimes/codex/dist/configuration.js';

// Installed native controls, with no model call or credentials.
const root = await realpath(await mkdtemp(join(tmpdir(), 'jevellan-native-contract-')));
let control;
try {
  const user = join(root, 'user'); await mkdir(user);
  const homes = new Homes(join(user, '.jevellan'), user);
  const cwd = join(root, 'project.with.dots'); await mkdir(cwd);
  execFileSync('git', ['init', '--initial-branch=main', cwd], { stdio: 'ignore' });
  await mkdir(join(cwd, '.codex'));
  await writeFile(join(cwd, '.codex/config.toml'), 'model_reasoning_effort = "low"\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "printf project-hook-must-not-load"\n');
  const account = { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_native', runtime: 'codex', label: 'Native control fixture', kind: 'subscription', credential: 'per-device', enabled: true }), home: homes.account('codex', 'acc_native'), env: {} };
  await new RiggingDelivery(homes).materialise('codex', account.home, [RiggingItemSchema.parse({ schema: 'rigging-item-v1', id: 'builtin_project_memory', name: 'Project memory', runtime: 'codex', kind: 'hook', enabled: true, state: 'owned', builtIn: true, content: JSON.stringify(projectMemoryHooks()), updatedAt: new Date().toISOString() })]);
  control = await CodexControl.open(account, 'codex', [projectTrustOverride(cwd), 'features.hooks=true', 'hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command="printf {}",timeout=3}]}]']);
  const listed = z.object({ data: z.array(z.object({ cwd: z.string(), errors: z.array(z.unknown()), hooks: z.array(z.object({ eventName: z.string(), command: z.string(), source: z.string(), timeoutSec: z.number() })) })) }).parse(await control.request('hooks/list', { cwds: [cwd] }));
  const hookEntry = listed.data.find((entry) => entry.cwd === cwd);
  assert(hookEntry && hookEntry.errors.length === 0, 'Native hook discovery reported errors.');
  const captureEvents = hookEntry.hooks.filter((hook) => hook.command.includes('memory-hook'));
  assert.deepEqual(captureEvents.map((hook) => hook.eventName).sort(), ['preCompact', 'sessionEnd', 'stop']);
  assert(captureEvents.every((hook) => hook.source === 'user' && hook.timeoutSec === 3), 'Capture was not loaded from the isolated account layer.');
  assert(hookEntry.hooks.some((hook) => hook.eventName === 'preToolUse' && hook.source === 'sessionFlags'), 'Per-launch hooks did not coexist with account hooks.');
  assert(!hookEntry.hooks.some((hook) => hook.command.includes('project-hook-must-not-load')), 'Untrusted project hook loaded.');
  const configuration = z.object({ config: z.object({ projects: z.record(z.string(), z.object({ trust_level: z.string().optional() })) }), layers: z.array(z.object({ disabledReason: z.string().nullable().optional() }).passthrough()).optional() }).parse(await control.request('config/read', { cwd, includeLayers: true }));
  const exactPath = configuration.config.projects[cwd]?.trust_level === 'untrusted';
  const excluded = configuration.layers?.some((layer) => /untrusted|not trusted|disabled/i.test(layer.disabledReason ?? '')) ?? false;
  assert(exactPath, 'Project trust did not retain the complete dotted path.');
  assert(excluded, 'The native project configuration layer was not reported as disabled.');
  const commandResult = z.object({ exitCode: z.number().int(), stderr: z.string(), stdout: z.string() });
  await writeFile(join(cwd, 'readable.txt'), 'read-control');
  const read = commandResult.parse(await control.request('command/exec', { command: ['/bin/cat', 'readable.txt'], cwd, timeoutMs: 10_000, sandboxPolicy: { type: 'readOnly', networkAccess: false } }));
  assert(read.exitCode === 0 && read.stdout === 'read-control', 'The positive read control failed; write denials would be inconclusive.');
  const write = commandResult.parse(await control.request('command/exec', { command: ['/bin/sh', '-c', 'printf allowed > allowed.txt'], cwd, timeoutMs: 10_000, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }));
  assert(write.exitCode === 0 && await access(join(cwd, 'allowed.txt')).then(() => true, () => false), 'The positive write control failed; read-only enforcement would be inconclusive.');
  const checks = [];
  for (const [name, command] of [
    ['shell-redirection', ['/bin/sh', '-c', 'printf test > shell-write.txt']],
    ['programmatic-write', [process.execPath, '-e', 'require("node:fs").writeFileSync("program-write.txt", "test")']],
  ]) {
    const result = commandResult.parse(await control.request('command/exec', { command, cwd, timeoutMs: 10_000, sandboxPolicy: { type: 'readOnly', networkAccess: false } }));
    const file = name === 'shell-redirection' ? 'shell-write.txt' : 'program-write.txt';
    const exists = await access(join(cwd, file)).then(() => true, () => false);
    const denied = result.exitCode !== 0 && /denied|not permitted|read-only|EPERM|EACCES/i.test(result.stderr);
    assert(denied && !exists, `${name} was not refused by the native sandbox.`);
    checks.push({ name, denied, fileCreated: exists });
  }
  console.log(JSON.stringify({ schema: 'codex-native-controls-v1', evidence: 'installed-runtime-no-model', exactProjectPath: exactPath, projectLayerExcluded: excluded, accountCaptureEvents: captureEvents.map((hook) => hook.eventName), perLaunchHooksCoexist: true, positiveRead: true, positiveWrite: true, checks, passed: true }, null, 2));
} finally { await control?.close(); await rm(root, { recursive: true, force: true }); }
