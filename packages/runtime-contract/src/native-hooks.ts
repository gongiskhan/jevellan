import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { NativeLaunchSetup } from '@jevellan/core';

const Output = z.object({ hookSpecificOutput: z.object({ permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(), permissionDecisionReason: z.string().optional(), additionalContext: z.string().optional() }).optional(), decision: z.string().optional(), reason: z.string().optional() });
/** Native commands follow Safety, run with filtered authentication and cannot write the native setup. */
export async function nativePreToolUse(setup: NativeLaunchSetup | undefined, event: unknown, options: { home: string; cwd: string; writable: boolean; env: Record<string, string> }): Promise<{ hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision?: 'deny' | 'ask'; permissionDecisionReason?: string; additionalContext?: string } }> {
  if (!setup?.hooks?.length || !setup.userHome) return {};
  const input = z.object({ tool_name: z.string() }).passthrough().parse(event);
  const inherited = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR']);
  const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => inherited.has(key)));
  let context = '';
  for (const group of setup.hooks) {
    if (group.matcher && !new RegExp(group.matcher).test(input.tool_name)) continue;
    for (const command of group.commands) {
      const nativeHome = realpathSync(setup.userHome!);
      const protect = ['.claude', '.claude.json', '.codex', '.cursor', '.gemini', '.basic-memory', 'basic-memory', '.config', '.ssh', '.gitconfig', '.zshrc', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile'].map(name => join(nativeHome, name));
      let executable: string, args: string[];
      if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
        const policy = `(version 1) (allow default) (deny file-write* ${protect.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')}${options.writable ? '' : ` (subpath ${JSON.stringify(realpathSync(options.cwd))})`})`;
        executable = '/usr/bin/sandbox-exec'; args = ['-p', policy, '/bin/sh', '-c', command];
      } else if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
        executable = '/usr/bin/bwrap'; args = ['--die-with-parent', '--ro-bind', '/', '/', '--bind', options.home, options.home, '--tmpfs', '/tmp', ...(options.writable ? ['--bind', options.cwd, options.cwd] : []), '--', '/bin/sh', '-c', command];
      } else continue;
      const result = await new Promise<{ code: number; text: string }>(resolve => {
        const child = spawn(executable, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
        let text = ''; const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
        child.stdout.on('data', (data: Buffer) => { if (text.length + data.length > 64_000) child.kill('SIGKILL'); else text += data.toString('utf8'); });
        child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(event));
        child.once('error', () => { clearTimeout(timeout); resolve({ code: 1, text: '' }); });
        child.once('exit', code => { clearTimeout(timeout); resolve({ code: code ?? 1, text }); });
      });
      if (result.code === 2) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'A native user hook blocked this tool.' } };
      try {
        const output = Output.parse(JSON.parse(result.text)); const hook = output.hookSpecificOutput;
        if (hook?.permissionDecision === 'deny' || hook?.permissionDecision === 'ask' || output.decision === 'block') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: hook?.permissionDecision === 'ask' ? 'ask' : 'deny', permissionDecisionReason: hook?.permissionDecisionReason ?? output.reason ?? 'A native user hook blocked this tool.' } };
        if (hook?.additionalContext) context += hook.additionalContext + '\n';
      } catch { /* Non-JSON success output does not change execution controls. */ }
    }
  }
  return context ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context.slice(0, 32_000) } } : {};
}
