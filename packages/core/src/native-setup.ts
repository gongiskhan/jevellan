import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { inside } from './homes.js';
import { NativeLaunchSetupSchema, NativeSetupInventorySchema, type NativeLaunchSetup, type NativeSetupInventory } from './native-setup-schemas.js';
import type { Homes } from './homes.js';
import { SecretRedactor } from './environment.js';

const document = z.record(z.string(), z.json());
const claudeSettings = new Set(['language', 'outputStyle', 'spinnerTipsEnabled', 'spinnerVerbs', 'preferredNotifChannel', 'respectGitignore', 'syntaxHighlightingEnabled']);
const codexSettings = new Set(['personality', 'hide_agent_reasoning', 'show_raw_agent_reasoning', 'web_search', 'response_style', 'tool_output_token_limit']);
export type NativeMcp = { name: string; command?: string; args: string[]; env: Record<string, string>; url?: string; transport?: 'http' | 'sse'; headers?: Record<string, string> };
export type NativeSetup = { launch: NativeLaunchSetup; inventory: NativeSetupInventory; mcp: NativeMcp[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Bounded reads only. Credential/configuration files are never copied into account homes. */
export function nativeSetup(homes: Homes, runtime: 'claude' | 'codex', accountHome?: string, enabled = true, redactor?: SecretRedactor): NativeSetup {
  const secrets = redactor ?? new SecretRedactor();
  const root = join(homes.userHome, `.${runtime}`), items: NativeSetupInventory['items'] = [];
  const launch: NativeLaunchSetup = { schema: 'native-launch-setup-v1', instructions: '', settings: {}, plugins: [] }, mcp: NativeMcp[] = [];
  const privateValues = new Set<string>();
  const protectedVariable = (key: string) => ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'].includes(key) || key.startsWith('JEVELLAN_');
  const environmentValue = (key: string): string => {
    if (protectedVariable(key)) throw new Error('Jevellan homes and provider credentials cannot be forwarded.');
    const value = process.env[key]; if (value === undefined) throw new Error('A native environment variable is unavailable.'); return value;
  };
  const expand = (value: string): string => runtime === 'codex' ? value : value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_match, key: string, fallback: string | undefined) => {
    if (protectedVariable(key)) throw new Error('Jevellan homes and provider credentials cannot be forwarded.');
    const result = process.env[key] === undefined && fallback !== undefined ? fallback : environmentValue(key);
    if (/token|key|password|secret|credential/iu.test(key)) { secrets.add(result); privateValues.add(result); } return result;
  });
  if (runtime === 'codex' && accountHome) {
    const delivery = join(accountHome, 'prompts'), prefix = `native_${hash(join(root, 'prompts'))}_`;
    if (existsSync(delivery)) for (const child of readdirSync(delivery)) if (child.startsWith(prefix)) rmSync(join(delivery, child), { recursive: true, force: true });
  }
  const item = (path: string, label: string, mechanism: NativeSetupInventory['items'][number]['mechanism'], applied: boolean, reason?: string) => items.push({ path, item: label, mechanism, applied, ...(reason ? { reason } : {}) });
  const read = (path: string, limit = 1024 * 1024): string => {
    const info = lstatSync(path); if (!info.isFile() || info.size > limit) throw new Error('Not a regular file within the supported size.');
    return readFileSync(path, 'utf8');
  };
  const finish = (): NativeSetup => ({ launch: NativeLaunchSetupSchema.parse({ ...launch, instructions: secrets.text(launch.instructions), settings: secrets.document(launch.settings), ...(launch.hooks ? { hooks: secrets.document(launch.hooks) } : {}) }), inventory: NativeSetupInventorySchema.parse(secrets.document({ schema: 'native-setup-inventory-v1', runtime, enabled, items })), mcp });
  if (!enabled) { item(root, 'Native setup', 'none', false, 'Disabled for this runtime.'); return finish(); }
  const instructions = join(root, runtime === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
  if (existsSync(instructions)) {
    try { launch.instructions = read(instructions, 32_768); item(instructions, 'Instructions', 'prompt', true); }
    catch { item(instructions, 'Instructions', 'none', false, 'Unreadable, linked or larger than 32768 bytes.'); }
  }
  const config = join(root, runtime === 'claude' ? 'settings.json' : 'config.toml');
  let settings: z.infer<typeof document> = {};
  if (existsSync(config)) {
    try { settings = document.parse(runtime === 'claude' ? JSON.parse(read(config)) : parse(read(config)));
      for (const [name, value] of Object.entries(settings)) {
        if ((runtime === 'claude' ? claudeSettings : codexSettings).has(name)) { launch.settings[name] = value; item(config, name, 'launch', true); }
        else if (!['mcp_servers', 'enabledPlugins', 'hooks'].includes(name)) item(config, name, 'none', false, 'Authentication, execution controls or a setting without supported per-launch delivery stay with Jevellan.');
      }
    } catch { item(config, 'Settings', 'none', false, 'Unreadable or invalid native configuration.'); }
  }
  // Native MCP credentials remain in memory; only public transport definitions are sent to runtime flags.
  const mcpPath = runtime === 'claude' ? join(homes.userHome, '.claude.json') : config;
  try {
    const raw = runtime === 'claude' ? existsSync(mcpPath) ? z.object({ mcpServers: document.optional() }).parse(JSON.parse(read(mcpPath))).mcpServers ?? {} : {} : settings.mcp_servers ?? {};
    for (const [name, value] of Object.entries(document.parse(raw))) {
      try {
        const definition = z.strictObject({ type: z.enum(['stdio', 'http', 'streamable-http', 'sse']).optional(), command: z.string().optional(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}),
          url: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), http_headers: z.record(z.string(), z.string()).optional(), env_http_headers: z.record(z.string(), z.string()).optional(), env_vars: z.array(z.union([z.string(), z.object({ name: z.string(), source: z.literal('local') })])).optional(), bearer_token_env_var: z.string().optional(), enabled: z.boolean().optional() }).parse(value);
        const entries = (values: Record<string, string> | undefined) => Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, expand(value)]));
        const server = { ...definition, command: definition.command ? expand(definition.command) : undefined, args: definition.args.map(expand), env: entries(definition.env), url: definition.url ? z.url().parse(expand(definition.url)) : undefined };
        if (server.enabled === false) { item(mcpPath, `MCP ${name}`, 'none', false, 'Disabled in the native configuration.'); continue; }
        for (const variable of server.env_vars ?? []) { const key = typeof variable === 'string' ? variable : variable.name; server.env[key] = environmentValue(key); }
        if (Object.keys(server.env).some(protectedVariable)) throw new Error('Native MCP environment cannot replace Jevellan homes or authentication.');
        if (['jevellan', 'memory', 'basic-memory'].includes(name)) throw new Error('A Jevellan MCP keeps its name.');
        if (!server.command && !server.url) throw new Error('Missing transport.');
        const headers = { ...entries(server.http_headers), ...entries(server.headers) };
        for (const [header, variable] of Object.entries(server.env_http_headers ?? {})) headers[header] = environmentValue(variable);
        if (server.bearer_token_env_var) {
          const token = environmentValue(server.bearer_token_env_var); if (!token) throw new Error('The native bearer-token variable is not available to the daemon.'); headers.Authorization = `Bearer ${token}`;
        }
        const values = [...Object.values(server.env), ...Object.values(headers).flatMap(value => [value, ...(/^Bearer\s+(.+)$/iu.exec(value)?.slice(1) ?? [])])];
        if (server.url) { const url = new URL(server.url); values.push(url.username, url.password); for (const [key, value] of url.searchParams) if (/token|key|password|secret|credential/iu.test(key)) values.push(value); }
        for (const value of values) if (value) { secrets.add(value); privateValues.add(value); }
        if (server.args.some(arg => /--(?:token|password|secret|api[-_]key|authorization)(?:=|$)/iu.test(arg)) || [server.command ?? '', ...server.args].some(arg => [...values, ...privateValues].some(value => value.length >= 4 && arg.includes(value)))) throw new Error('Credential-bearing arguments are unsupported.');
        mcp.push({ name: /^[a-zA-Z0-9_-]{1,80}$/u.test(name) ? name : `native_${hash(name)}`, args: server.args, env: server.env, ...(server.command ? { command: server.command } : {}), ...(server.url ? { url: server.url, transport: server.type === 'sse' ? 'sse' : 'http', headers } : {}) });
        item(mcpPath, `MCP ${name}`, 'launch', true);
      } catch { item(mcpPath, `MCP ${name}`, 'none', false, ['jevellan', 'memory', 'basic-memory'].includes(name) ? 'Jevellan keeps its MCP server on a name clash.' : 'Unsupported transport, invalid definition or unavailable environment authentication.'); }
    }
  } catch { item(mcpPath, 'MCP servers', 'none', false, 'Unreadable or invalid user-scope configuration.'); }

  // Each copy has its own generation, allowing concurrent turns to read a stable snapshot.
  const generation = accountHome ? join(accountHome, 'native-setup', `${Date.now()}-${hash(String(Math.random()))}`) : undefined;
  const copyTree = (source: string, destination: string | undefined, confinement: string): void => {
    let total = 0, files = 0; const visited = new Set<string>();
    const walk = (from: string, to: string | undefined): void => {
      if (['.mcp.json', 'auth.json', '.env', 'settings.json', 'config.toml', 'hooks'].includes(basename(from))) return;
      const canonical = realpathSync(from); if (!inside(confinement, canonical) || visited.has(canonical)) throw new Error('A native item links outside its root or contains a cycle.');
      visited.add(canonical); const info = lstatSync(canonical);
      if (info.isDirectory()) { if (to) mkdirSync(to, { recursive: true, mode: 0o700 }); for (const name of readdirSync(canonical).sort()) walk(join(canonical, name), to ? join(to, name) : undefined); }
      else if (info.isFile()) { total += info.size; files++; if (info.size > 1024 * 1024 || total > 8 * 1024 * 1024 || files > 2000) throw new Error('A native item exceeds the supported copy size.');
        const bytes = readFileSync(canonical);
        for (const secret of privateValues) if (secret.length >= 4 && bytes.includes(Buffer.from(secret))) throw new Error('A native item embeds an MCP credential.');
        if (to) mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        if (basename(canonical) === 'plugin.json') { const manifest = document.parse(JSON.parse(bytes.toString('utf8'))); delete manifest.mcpServers; delete manifest.hooks; if (to) writeFileSync(to, JSON.stringify(manifest), {mode:0o600}); }
        else if (to) writeFileSync(to, bytes, { mode: 0o600 | (info.mode & 0o111) });
      } else throw new Error('Unsupported native file.');
      visited.delete(canonical);
    };
    try { walk(source, destination); } catch (error) { if (destination) rmSync(destination, { recursive: true, force: true }); throw error; }
  };
  for (const name of runtime === 'claude' ? ['skills', 'agents', 'commands', 'output-styles'] : ['skills', 'prompts']) {
    const path = join(root, name); if (!existsSync(path)) continue;
    try {
      if (!generation) copyTree(path, undefined, realpathSync(root));
      if (generation) {
        const target = join(generation, name); copyTree(path, target, realpathSync(root));
        if (runtime === 'codex' && name === 'skills') {
          const paths = readdirSync(target).map(child => join(target, child, 'SKILL.md')).filter(existsSync);
          launch.settings.skills = { config: paths.map(path => ({ path, enabled: true })) };
        } else if (runtime === 'codex') {
          const delivery = join(accountHome!, name); mkdirSync(delivery, { recursive: true, mode: 0o700 });
          for (const child of readdirSync(delivery)) if (child.startsWith(`native_${hash(path)}_`)) rmSync(join(delivery, child), { recursive: true, force: true });
          // Namespaced items do not replace rigging or an account's own items.
          for (const child of readdirSync(target)) copyTree(join(target, child), join(delivery, `native_${hash(path)}_${child}`), realpathSync(generation));
        }
      }
      item(path, name, 'copy', true);
    } catch { item(path, name, 'none', false, 'Unreadable, unsafe links or unsupported copy size.'); }
  }
  if (generation && existsSync(generation)) launch.generation = generation;
  if (runtime === 'claude' && generation && existsSync(generation)) launch.plugins.push(generation);
  if (runtime === 'claude' && settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins)) {
    const installedPath = join(root, 'plugins', 'installed_plugins.json');
    try {
      const installed = z.object({ plugins: z.record(z.string(), z.array(z.object({ installPath: z.string(), scope: z.string().optional() }))) }).parse(JSON.parse(read(installedPath)));
      for (const [name, active] of Object.entries(settings.enabledPlugins)) if (active === true) {
        const plugin = installed.plugins[name]?.find(entry => !entry.scope || entry.scope === 'user');
        if (!plugin || !inside(realpathSync(root), realpathSync(plugin.installPath))) { item(installedPath, name, 'none', false, 'No readable user installation in the native home.'); continue; }
        if (generation) { const target = join(generation, 'plugins', hash(name)); copyTree(plugin.installPath, target, realpathSync(root)); launch.plugins.push(target); }
        else copyTree(plugin.installPath, undefined, realpathSync(root));
        item(plugin.installPath, name, 'copy', true);
        if (existsSync(join(plugin.installPath, '.mcp.json')) || existsSync(join(plugin.installPath, 'hooks'))) item(plugin.installPath, `${name} plugin MCP and hooks`, 'none', false, 'Plugin transport and hooks require explicit user-scope configuration so credentials stay ephemeral and hooks follow Safety.');
      }
    } catch { item(installedPath, 'Enabled plugins', 'none', false, 'No supported installed-plugin inventory.'); }
  }
  if (settings.hooks) {
    try {
      if (runtime !== 'claude' || !(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec') || process.platform === 'linux' && existsSync('/usr/bin/bwrap'))) throw new Error('A protected hook launcher is unavailable.');
      const groups = z.object({ PreToolUse: z.array(z.object({ matcher: z.string().default(''), hooks: z.array(z.object({ type: z.literal('command'), command: z.string().min(1) })) })).optional() }).parse(settings.hooks).PreToolUse ?? [];
      for (const group of groups) if (group.matcher) new RegExp(group.matcher);
      launch.hooks = groups.map(group => ({ matcher: group.matcher, commands: group.hooks.filter(hook => {
        if (secrets.text(hook.command) === hook.command) return true;
        item(config, 'Credential-bearing user hook', 'none', false, 'A command containing an MCP credential cannot be passed in arguments.'); return false;
      }).map(hook => hook.command) })); launch.userHome = homes.userHome;
      if (groups.length) item(config, 'PreToolUse user hooks', 'launch', true);
      for (const name of Object.keys(document.parse(settings.hooks))) if (name !== 'PreToolUse') item(config, `${name} user hooks`, 'none', false, 'This hook event has no supported delivery after Jevellan Safety.');
    } catch { item(config, 'User hooks', 'none', false, 'Only supported command PreToolUse hooks can run after Jevellan Safety.'); }
  }
  return finish();
}
/** Only a completed worker removes its own immutable generation. */
export function removeNativeGeneration(accountHome: string, setup: NativeLaunchSetup): void {
  const base = join(accountHome, 'native-setup');
  for (const path of [...setup.plugins, ...(setup.generation ? [setup.generation] : [])]) if (inside(base, path)) rmSync(path, { recursive: true, force: true });
}
