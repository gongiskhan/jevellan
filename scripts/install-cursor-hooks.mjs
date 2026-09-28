import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { atomicWrite, CursorHookInstallationSchema, Homes, writeDocument } from '../packages/core/dist/index.js';

// Explicit operator installation only. Never called by daemon startup/build.
const userHome = resolve(process.env.JEVELLAN_CURSOR_USER_HOME || homedir());
const homes = new Homes(process.env.JEVELLAN_HOME || join(userHome, '.jevellan'), userHome);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'mesh', 'dist', 'standalone');
const files = ['cursor-hook.mjs', 'cursor-stdio.mjs'];
const digest = createHash('sha256'); for (const file of files) digest.update(readFileSync(join(source, file)));
const release = homes.ensure('cursor', 'bridge', digest.digest('hex').slice(0, 20));
for (const file of files) copyFileSync(join(source, file), join(release, file));
copyFileSync(join(root, 'node_modules', 'zod', 'LICENSE'), join(release, 'zod-LICENSE'));
copyFileSync(join(root, 'LICENSE'), join(release, 'LICENSE'));
const hookPath = join(release, 'cursor-hook.mjs');
const configFile = join(userHome, '.cursor', 'hooks.json');
const original = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null;
const Config = z.object({ version: z.literal(1), hooks: z.record(z.string(), z.array(z.object({ command: z.string() }).passthrough())) }).passthrough();
const config = Config.parse(original ? JSON.parse(original) : { version: 1, hooks: {} });
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const command = `${quote(process.execPath)} ${quote(hookPath)} ${quote(homes.root)}`;
const events = ['beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'stop', 'sessionEnd'];
const Install = CursorHookInstallationSchema;
const manifestFile = homes.at('cursor', 'bridge', 'installation.json');
const previous = existsSync(manifestFile) ? Install.parse(JSON.parse(readFileSync(manifestFile, 'utf8'))) : null;
// Remove only the exact command recorded by this installer's prior receipt.
for (const name of events) config.hooks[name] = (config.hooks[name] ?? []).filter(hook => hook.command !== previous?.command && hook.command !== command);
for (const name of events) config.hooks[name].push({ command, timeout: name === 'stop' ? 25_260 : 10, ...(name === 'stop' ? { loop_limit: null } : {}) });
if (original !== null) atomicWrite(homes.at('cursor', 'backups', `hooks-${Date.now()}.json`), original);
// Refuse to overwrite a concurrent Cursor/other-tool settings edit.
if ((existsSync(configFile) ? readFileSync(configFile, 'utf8') : null) !== original) throw new Error('Cursor hooks changed during installation. Retry to preserve the newer settings.');
mkdirSync(dirname(configFile), { recursive: true });
atomicWrite(configFile, JSON.stringify(config, null, 2) + '\n');
writeDocument(manifestFile, Install, { schema: 'cursor-hook-installation-v1', hookPath, helperPath: join(release, 'cursor-stdio.mjs'), executable: process.execPath, command, installedAt: new Date().toISOString() });
console.log('Jevellan Cursor hooks installed. Existing hook entries preserved. No session was started.');
console.log(`Helper: ${join(release, 'cursor-stdio.mjs')}`);
