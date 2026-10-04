import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

export const SAFETY_REASON = 'Jevellan handles this. Say what you need in your handoff.';
export const THREAD_SAFETY_REASON = 'Jevellan handles this. Report what you need with jevellan_thread_report.';
export const COORDINATOR_SAFETY_REASON = 'Jevellan handles this. Ask a thread to do it with jevellan_thread_message.';
export const COORDINATOR_READ_ONLY_REASON = 'The coordinator is read-only. Use the read tools and the Jevellan tools.';
const READ_ONLY_REASON = 'This step is read-only. Use the read tools and return a handoff.';
export type SafetyProfile = 'stretch' | 'coordinator' | 'thread';
// No profile means a stretch. Turns carry a profile and no action.
export type SafetyContext = { cwd: string; daemonPid: number; action?: string | undefined; profile?: SafetyProfile | undefined };
export function safetyReason(context: Pick<SafetyContext, 'profile'>): string {
  return context.profile === 'thread' ? THREAD_SAFETY_REASON : context.profile === 'coordinator' ? COORDINATOR_SAFETY_REASON : SAFETY_REASON;
}

// Ordinary shell forms only. Arbitrary programs can evade this command guard;
// post-stretch git checks remain required.
export function shellWords(command: string): string[][] {
  const groups: string[][] = [[]];
  let token = ''; let quote = ''; let escaped = false; let started = false;
  const finish = () => { if (started) groups.at(-1)!.push(token); token = ''; started = false; };
  for (const char of command) {
    if (escaped) { token += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else token += char; started = true; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (';&|\n'.includes(char)) { finish(); groups.push([]); continue; }
    if (/\s/.test(char)) { finish(); continue; }
    token += char; started = true;
  }
  if (escaped || quote) throw new Error('Unterminated shell command.');
  finish();
  return groups.filter((group) => group.length);
}

function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return parent === path ? path : resolve(canonical(parent), basename(path));
  }
}

export function safetyDenial(command: string, context: SafetyContext): string | null {
  let groups: string[][];
  try { groups = shellWords(command); } catch { return safetyReason(context); }
  for (const original of groups) {
    const words = [...original];
    while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['sudo', 'command', 'env', 'exec', 'nohup', '--'].includes(words[0]))) words.shift();
    const program = basename(words.shift() ?? '');
    if (['sh', 'bash', 'zsh', 'dash'].includes(program)) {
      const index = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
      if (index >= 0 && words[index + 1] && safetyDenial(words[index + 1]!, context)) return safetyReason(context);
    }
    if (program === 'git') {
      while (words[0]?.startsWith('-')) {
        const flag = words.shift();
        if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(flag ?? '')) words.shift();
      }
      const operation = words.shift();
      if (operation === 'push' || operation === 'clean' || (operation === 'rebase' && context.action !== 'integrate' && context.profile !== 'thread') ||
          (operation === 'reset' && words.includes('--hard')) || (operation === 'branch' && (words.includes('-D') || (words.includes('--delete') && words.includes('--force'))))) return safetyReason(context);
    }
    if (program === 'gh' && ((words[0] === 'repo' && ['edit', 'delete'].includes(words[1] ?? '')) ||
        (words[0] === 'api' && words.some((word) => /^(?:private|visibility)=|"(?:private|visibility)"\s*:/.test(word))))) return safetyReason(context);
    const jevellan = ['jevellan', 'jevellan.mjs'].includes(program) || program === 'node' && basename(words[0] ?? '') === 'jevellan.mjs' ||
      ['npx', 'npm'].includes(program) && words.some(word => word === 'jevellan' || /^github:gongiskhan\/jevellan(?:#.*)?$/.test(word) || word === 'git+https://github.com/gongiskhan/jevellan.git');
    if (jevellan && words.some((word) => ['install', 'join', 'stop', 'restart', 'update', 'rollback', 'uninstall'].includes(word))) return safetyReason(context);
    if (['launchctl', 'systemctl'].includes(program) && words.some((word) => /(?:dev\.jevellan\.daemon|jevellan\.service)/.test(word))) return safetyReason(context);
    if (program === 'kill' && words.some((word) => word === String(context.daemonPid) || word === `-${context.daemonPid}`)) return safetyReason(context);
    if (['pkill', 'killall'].includes(program) && words.some((word) => /jevellan|node/.test(word))) return safetyReason(context);
    if (program === 'rm') {
      const flags = words.filter((word) => word.startsWith('-'));
      const recursive = flags.some((flag) => flag === '--recursive' || /^-[^-]*[rR]/.test(flag));
      const force = flags.some((flag) => flag === '--force' || /^-[^-]*f/.test(flag));
      if (recursive && force) for (const target of words.filter((word) => !word.startsWith('-'))) {
        if (/[$`~*?]/.test(target)) return safetyReason(context);
        const rel = relative(canonical(resolve(context.cwd)), canonical(resolve(context.cwd, target)));
        if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return safetyReason(context);
      }
    }
  }
  return null;
}

export function claudeReadOnlyBridgeTools(memoryWrite: boolean): string[] {
  return ['jevellan_finding', 'jevellan_handoff', 'jevellan_conversation_search', 'jevellan_conversation_read', 'memory_search', 'memory_read', 'memory_propose',
    ...(memoryWrite ? ['memory_write', 'memory_edit'] : [])].map(name => `mcp__jevellan__${name}`);
}

export function claudeBridgeToolNames(names: readonly string[]): string[] { return names.map((name) => `mcp__jevellan__${name}`); }

// bridgeTools: the scope's exact read-only allow list, shared with the SDK's allowedTools (stretches derive it from memoryWrite).
export function claudePermissionHook(context: SafetyContext & { permissions: 'read-only' | 'write'; memoryWrite?: boolean; bridgeTools?: string[] }) {
  const allowed = context.bridgeTools ?? claudeReadOnlyBridgeTools(context.memoryWrite ?? false);
  return async (input: { tool_name?: string; tool_input?: unknown }) => {
    const tool = input.tool_name ?? '';
    let reason: string | null = null;
    if (context.permissions === 'read-only') {
      // Discovery loads tool definitions; the discovered invocation still passes
      // through this hook. Blocking it also blocks the required MCP handoff.
      const reads = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch'];
      if (!reads.includes(tool) && !allowed.includes(tool)) reason = context.profile === 'coordinator' ? COORDINATOR_READ_ONLY_REASON : READ_ONLY_REASON;
    }
    if (tool === 'Bash' && !reason) {
      const command = input.tool_input && typeof input.tool_input === 'object' && 'command' in input.tool_input ? input.tool_input.command : null;
      reason = typeof command === 'string' ? safetyDenial(command, context) : safetyReason(context);
    }
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } } : {};
  };
}
