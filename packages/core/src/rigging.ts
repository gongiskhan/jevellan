import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { stringify as toml } from 'smol-toml';
import { z } from 'zod';
import { Homes, inside, resolvedPath } from './homes.js';
import { atomicWrite, stableJson } from './files.js';
import { RiggingItemSchema, type RiggingItem } from './schemas.js';
import { minimalEnvironment, SecretRedactor } from './environment.js';
import { parseConfiguration } from './configuration.js';
import { PROJECT_MEMORY_ID } from './project-memory-rigging.js';
import { withRiggingHome } from './rigging-lock.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const RiggingDeliveryStateSchema = z.strictObject({ schema: z.literal('rigging-delivery-v1'), fingerprint: z.string(), files: z.record(z.string(), z.string()), claims: z.record(z.string(), z.strictObject({ schema: z.literal('rigging-claim-v1'), itemId: z.string(), sourceHash: z.string(), files: z.record(z.string(), z.string()), pending: z.boolean() })).default({}) });
const StateSchema = RiggingDeliveryStateSchema;
const LockSchema = z.object({ lockfile_version: z.string().optional(), dependencies: z.array(z.object({ repo_url: z.string().optional(), local_path: z.string().optional(), deployed_files: z.array(z.string()).optional() })).default([]) });
const JsonObject = z.record(z.string(), z.unknown());
export const McpRiggingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]) }),
  z.strictObject({ type: z.literal('http'), url: z.url({ protocol: /^https?$/ }) }),
]);
export const StableMcpSchema = z.strictObject({ schema: z.literal('stable-mcp-v1'), servers: z.record(z.string(), McpRiggingSchema) });
export type RiggingResult = { itemId: string; applied: boolean; reason?: string };
export type ApmRunner = (cwd: string, runtime: 'claude' | 'codex', env: Record<string, string>) => Promise<void>;
const runApm: ApmRunner = async (cwd, runtime, env) => {
  try { await promisify(execFile)('apm', ['install', '--target', runtime, '--only', 'apm'], { cwd, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }); }
  catch { throw new Error('APM installation failed. Check the package and APM availability.'); }
};
const kinds = { claude: ['skill', 'mcp', 'hook', 'rule', 'setting', 'command'], codex: ['skill', 'mcp', 'hook', 'rule', 'setting'] } as const;
export function supportedRigging(runtime: 'claude' | 'codex'): RiggingItem['kind'][] { return [...kinds[runtime]]; }
function yaml(value: string): unknown { const document = parseDocument(value, { uniqueKeys: true }); if (document.errors.length) throw new Error('Invalid APM YAML.'); return document.toJS({ maxAliasCount: 20 }); }
function write(path: string, content: string | Buffer, mode = 0o600): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); atomicWrite(path, content, mode); }
function confined(root: string, ref: string): string {
  const path = resolvedPath(join(root, ref));
  if (!inside(root, path) || path === root || path !== join(root, ref)) throw new Error('Rigging file escapes or aliases its destination.');
  return path;
}
function files(root: string): string[] {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error('APM output cannot contain symbolic links.');
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('APM output cannot contain symbolic links.');
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

/** APM deploys into private staging; only verified runtime files reach an account. */
export class RiggingDelivery {
  constructor(readonly homes: Homes, readonly runner: ApmRunner = runApm, readonly redactor = new SecretRedactor()) {}
  async materialise(runtime: 'claude' | 'codex', home: string, raw: RiggingItem[]): Promise<RiggingResult[]> {
    return withRiggingHome(home, () => this.#apply(runtime, home, raw));
  }
  async #apply(runtime: 'claude' | 'codex', home: string, raw: RiggingItem[]): Promise<RiggingResult[]> {
    const accountId = basename(home);
    if (this.homes.account(runtime, accountId) !== home) throw new Error('Rigging requires an account home owned by Jevellan.');
    const items = raw.map((item) => RiggingItemSchema.parse(item)).filter((item) => item.runtime === runtime);
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Rigging item ids must be unique per runtime.');
    for (const item of items) {
      if (this.redactor.text(item.content) !== item.content || item.bundle?.files.some((file) => { const content = Buffer.from(file.base64, 'base64').toString('utf8'); return this.redactor.text(content) !== content; })) throw new Error('Store credentials in Accounts, not in Rigging content.');
    }
    const selected = items.filter((item) => item.enabled && item.state !== 'parked' && supportedRigging(runtime).includes(item.kind));
    const configPath = this.homes.at('apm.yml');
    const configured = existsSync(configPath) ? parseConfiguration(readFileSync(configPath, 'utf8')).dependencies.apm : [];
    const fingerprint = hash(stableJson({ selected, configured }));
    const statePath = this.homes.at('rigging', 'state', runtime, `${accountId}.json`);
    const previous = existsSync(statePath) ? StateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8'))) : StateSchema.parse({ schema: 'rigging-delivery-v1', fingerprint: '', files: {} });
    if (Object.values(previous.claims).some((claim) => claim.pending)) throw new Error('A Rigging promotion needs to finish. Retry it before applying this account.');
    const results = (): RiggingResult[] => items.map((item) => ({ itemId: item.id, applied: selected.includes(item), ...(!supportedRigging(runtime).includes(item.kind) ? { reason: `Not supported by ${runtime === 'codex' ? 'Codex' : 'Claude Code'}` } : !item.enabled || item.state === 'parked' ? { reason: 'Parked or disabled.' } : {}) }));
    if (previous.fingerprint === fingerprint && Object.entries(previous.files).every(([ref, expected]) => { const path = confined(home, ref); return existsSync(path) && lstatSync(path).isFile() && hash(readFileSync(path)) === expected; })) return results();
    const stage = this.homes.ensure('rigging', 'stages', runtime, accountId, fingerprint);
    const dependencies: Array<string | { path: string } | { repo: string }> = [...configured];
    const settings: Record<string, unknown> = {}; const servers: Record<string, unknown> = {};
    const rules: string[] = [];
    const skillNames = new Set<string>();
    for (const item of selected) {
      if (item.packageRef) { dependencies.push(item.packageRef); continue; }
      const packagePath = this.homes.ensure('rigging', 'packages', runtime, item.id, hash(stableJson({ content: item.content, bundle: item.bundle })));
      write(join(packagePath, 'apm.yml'), stringify({ name: item.id, version: '1.0.0', description: item.name }));
      write(join(packagePath, 'item.json'), JSON.stringify(item));
      const name = item.bundle?.name ?? item.id.replaceAll('_', '-').toLowerCase();
      if (item.kind === 'skill') {
        if (skillNames.has(name)) throw new Error(`Two managed skills use the same bundle name: ${name}.`);
        skillNames.add(name);
        const folder = join(packagePath, '.apm', 'skills', name);
        write(join(folder, 'SKILL.md'), item.bundle || item.content.startsWith('---') ? item.content : `---\n${stringify({ name, description: item.name })}---\n${item.content}\n`);
        for (const file of item.bundle?.files ?? []) write(confined(folder, file.ref), Buffer.from(file.base64, 'base64'), file.executable ? 0o700 : 0o600);
      }
      if (item.kind === 'command') write(join(packagePath, '.apm', 'prompts', `${name}.prompt.md`), item.content);
      if (item.kind === 'rule') {
        if (runtime === 'claude') write(join(packagePath, '.apm', 'instructions', `${name}.instructions.md`), item.content);
        else rules.push(item.content);
      }
      if (item.kind === 'hook') write(join(packagePath, '.apm', 'hooks', `${name}.json`), JSON.stringify(JsonObject.parse(JSON.parse(item.content))));
      if (item.kind === 'setting') Object.assign(settings, JsonObject.parse(JSON.parse(item.content)));
      if (item.kind === 'mcp') {
        const server = McpRiggingSchema.parse(JSON.parse(item.content));
        servers[name] = runtime === 'codex' ? server.type === 'stdio' ? { command: server.command, args: server.args } : { url: server.url } : server;
      }
      dependencies.push({ path: packagePath });
    }
    write(join(stage, 'apm.yml'), stringify({ name: 'jevellan-rigging', version: '1.0.0', target: runtime, dependencies: { apm: dependencies } }));
    if (dependencies.length) {
      // APM deploys Codex hooks only when the target directory already exists.
      mkdirSync(join(stage, `.${runtime}`), { recursive: true, mode: 0o700 });
      await this.runner(stage, runtime, { ...minimalEnvironment(runtime, join(stage, `.${runtime}`)), HOME: this.homes.ensure('apm', 'user'), PYTHONDONTWRITEBYTECODE: '1' });
      LockSchema.parse(yaml(readFileSync(join(stage, 'apm.lock.yaml'), 'utf8')));
    } else write(join(stage, 'apm.lock.yaml'), stringify({ lockfile_version: '1', dependencies: [] }));
    const staged = new Map<string, Buffer>();
    const modes = new Map<string, number>();
    const prefixes = runtime === 'claude' ? ['.claude'] : ['.agents', '.codex'];
    for (const prefix of prefixes) for (const path of files(join(stage, prefix))) {
      const ref = relative(join(stage, prefix), path);
      if (!/^(skills\/|rules\/|commands\/|hooks\/|hooks\.json$|settings\.json$|config\.toml$)/.test(ref)) throw new Error('APM produced an unsupported runtime file.');
      if (staged.has(ref)) throw new Error('APM produced conflicting runtime files.');
      staged.set(ref, readFileSync(path));
      modes.set(ref, lstatSync(path).mode & 0o111 ? 0o700 : 0o600);
    }
    for (const item of selected) if (item.bundle && item.kind === 'skill') {
      const folder = `skills/${item.bundle.name}`;
      if (staged.get(`${folder}/SKILL.md`)?.toString() !== item.content || item.bundle.files.some((file) => !staged.get(`${folder}/${file.ref}`)?.equals(Buffer.from(file.base64, 'base64')) || Boolean((modes.get(`${folder}/${file.ref}`) ?? 0) & 0o111) !== file.executable)) throw new Error('APM did not preserve every file in the captured skill bundle. The account files were preserved.');
    }
    if (runtime === 'claude' && Object.keys(settings).length) {
      const generated = JsonObject.parse(JSON.parse(staged.get('settings.json')?.toString() ?? '{}'));
      const merged = { ...generated, ...settings };
      if (generated.hooks && settings.hooks) {
        const Hooks = z.record(z.string(), z.array(z.json()));
        const hooks = Hooks.parse(generated.hooks);
        for (const [event, groups] of Object.entries(Hooks.parse(settings.hooks))) hooks[event] = [...hooks[event] ?? [], ...groups];
        merged.hooks = hooks;
      }
      staged.set('settings.json', Buffer.from(`${JSON.stringify(merged, null, 2)}\n`));
    }
    if (runtime === 'claude' && Object.keys(servers).length) staged.set('jevellan-mcp.json', Buffer.from(JSON.stringify(StableMcpSchema.parse({ schema: 'stable-mcp-v1', servers }))));
    if (runtime === 'codex') {
      if (Object.keys(settings).length || Object.keys(servers).length) staged.set('config.toml', Buffer.from(toml({ ...settings, ...(Object.keys(servers).length ? { mcp_servers: servers } : {}) })));
      if (rules.length) staged.set('AGENTS.md', Buffer.from(rules.join('\n\n')));
    }
    const capture = selected.find((item) => item.id === PROJECT_MEMORY_ID);
    if (capture) {
      const Hooks = z.object({ hooks: z.record(z.string(), z.array(z.object({ hooks: z.array(z.object({ type: z.string(), command: z.string().optional(), timeout: z.number().optional() })) }))) });
      const expected = Hooks.parse(JSON.parse(capture.content));
      const delivered = Hooks.safeParse(JSON.parse(staged.get(runtime === 'claude' ? 'settings.json' : 'hooks.json')?.toString() ?? '{}'));
      if (!delivered.success || Object.entries(expected.hooks).some(([event, groups]) => groups.some((group) => group.hooks.some((hook) => !delivered.data.hooks[event]?.some((entry) => entry.hooks.some((actual) => actual.type === hook.type && actual.command === hook.command && actual.timeout === hook.timeout)))))) throw new Error('APM did not deliver the required Project memory hooks.');
    }
    // A loose file, or an owned file edited outside Rigging, is never overwritten.
    const conflicts: string[] = [];
    for (const [ref, contents] of staged) {
      const path = confined(home, ref);
      if (existsSync(path) && (!lstatSync(path).isFile() || (hash(readFileSync(path)) !== previous.files[ref] && hash(readFileSync(path)) !== hash(contents)))) conflicts.push(ref);
    }
    for (const ref of Object.keys(previous.files)) {
      const path = confined(home, ref);
      if (!staged.has(ref) && existsSync(path) && (!lstatSync(path).isFile() || hash(readFileSync(path)) !== previous.files[ref])) conflicts.push(ref);
    }
    if (conflicts.length) throw new Error(`Rigging preserved local changes: ${conflicts.join(', ')}. Park or keep those items before applying.`);
    const next: Record<string, string> = {};
    for (const [ref, contents] of staged) { const path = confined(home, ref); write(path, contents, modes.get(ref)); next[ref] = hash(contents); }
    for (const ref of Object.keys(previous.files)) if (!staged.has(ref)) {
      const source = confined(home, ref); if (!existsSync(source)) continue;
      const destination = this.homes.at('rigging', 'parked', runtime, accountId, previous.fingerprint, ref);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); renameSync(source, destination);
      let directory = dirname(source);
      while (directory !== home) {
        try { rmdirSync(directory); } catch (error) { if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) break; throw error; }
        directory = dirname(directory);
      }
    }
    write(statePath, JSON.stringify(StateSchema.parse({ schema: 'rigging-delivery-v1', fingerprint, files: next, claims: previous.claims })));
    return results();
  }
}
