import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicWrite, resolvedPath, type Homes } from '@jevellan/core';
import { z } from 'zod';
import type { InstallationFiles, InstallationManifest } from './installation-files.js';

const AbsolutePath = z.string().refine(isAbsolute);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CommandDefinitionSchema = z.strictObject({
  schema: z.literal('command-definition-v1'), path: AbsolutePath, node: AbsolutePath, entry: AbsolutePath, home: AbsolutePath,
});
export const InstalledCommandSchema = z.strictObject({
  schema: z.literal('installed-command-v1'), definition: CommandDefinitionSchema, digest: Digest,
});
export const PendingCommandSchema = z.strictObject({
  schema: z.literal('command-write-v1'), definition: CommandDefinitionSchema, beforeDigest: Digest.nullable(), temporary: AbsolutePath,
});
export type CommandDefinition = z.infer<typeof CommandDefinitionSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replace(/'/gu, `'"'"'`)}'`;
const paths = (homes: Homes) => [join(homes.userHome, '.local', 'bin', 'jevellan'), join(homes.userHome, 'bin', 'jevellan')];

export function commandContents(input: CommandDefinition): string {
  const spec = CommandDefinitionSchema.parse(input);
  return `#!/bin/sh\nJEVELLAN_HOME=${quote(spec.home)} exec ${quote(spec.node)} ${quote(spec.entry)} "$@"\n`;
}

export function commandOnPath(path: string, search = process.env.PATH ?? ''): boolean {
  for (const entry of search.split(delimiter)) {
    const candidate = resolve(entry, 'jevellan');
    try { if (!statSync(candidate).isFile()) continue; accessSync(candidate, constants.X_OK); }
    catch { continue; }
    return resolvedPath(candidate) === path;
  }
  return false;
}

export function commandPath(files: InstallationFiles, search?: string): string {
  const manifest = files.load();
  const entries = (search ?? process.env.PATH ?? '').split(delimiter);
  return manifest.command?.definition.path ?? manifest.pendingCommand?.definition.path ?? paths(files.homes).find(path => entries.some(entry => entry && isAbsolute(entry) && resolve(entry) === dirname(path))) ?? paths(files.homes)[0]!;
}

export function validateCommands(homes: Homes, manifest: InstallationManifest): void {
  const allowed = paths(homes);
  for (const definition of [manifest.command?.definition, manifest.pendingCommand?.definition]) {
    if (definition && (!allowed.includes(definition.path) || definition.home !== homes.root || !manifest.applications.some(app => definition.entry === join(app.path, 'bin', 'jevellan.mjs')))) throw new Error('The command must run a recorded application from this installation.');
  }
  if (manifest.command && manifest.command.digest !== digest(commandContents(manifest.command.definition))) throw new Error('The command receipt does not match this installation.');
  if (manifest.pendingCommand && manifest.pendingCommand.temporary !== join(dirname(manifest.pendingCommand.definition.path), `.jevellan-command-${manifest.id}.tmp`)) throw new Error('The command staging path does not belong to this installation.');
  const directories = [join(homes.userHome, '.local'), ...allowed.map(dirname)];
  if (manifest.commandDirectories.some(path => !directories.includes(path))) throw new Error('A command directory does not belong to this installation.');
}

function currentDigest(path: string): string | null {
  if (resolvedPath(path) !== path) throw new Error('The command path has changed outside Jevellan.');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The command path is occupied by another filesystem entry.');
  return digest(readFileSync(path, 'utf8'));
}

/** Check before stopping the service so a conflicting command leaves running work alone. */
export function checkCommand(files: InstallationFiles, input: CommandDefinition): void {
  const definition = CommandDefinitionSchema.parse(input), manifest = files.load();
  validateCommands(files.homes, { ...manifest, command: { schema: 'installed-command-v1', definition, digest: digest(commandContents(definition)) } });
  if (manifest.command && manifest.command.definition.path !== definition.path) throw new Error('Keep this installation’s recorded command path.');
  if (manifest.pendingCommand && digest(commandContents(manifest.pendingCommand.definition)) !== digest(commandContents(definition))) throw new Error('Finish the pending command change before switching versions.');
  const current = currentDigest(definition.path);
  if (current !== null && current !== manifest.command?.digest && !(manifest.pendingCommand && [manifest.pendingCommand.beforeDigest, digest(commandContents(manifest.pendingCommand.definition))].includes(current))) throw new Error('The existing command was changed outside Jevellan. Its files were preserved.');
}

export function writeCommand(files: InstallationFiles, input: CommandDefinition): void {
  checkCommand(files, input);
  const definition = CommandDefinitionSchema.parse(input), manifest = files.load();
  const content = commandContents(definition), after = digest(content), before = currentDigest(definition.path);
  if (before === after && (lstatSync(definition.path).mode & 0o111) === 0o111) {
    if (manifest.pendingCommand) {
      const temporary = manifest.pendingCommand.temporary;
      if (resolvedPath(temporary) !== temporary) throw new Error('The command staging path has changed.');
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    manifest.command = { schema: 'installed-command-v1', definition, digest: after }; delete manifest.pendingCommand; files.save(manifest); return;
  }
  const missing: string[] = []; let directory = dirname(definition.path);
  while (!existsSync(directory)) { missing.unshift(directory); directory = dirname(directory); }
  const temporary = join(dirname(definition.path), `.jevellan-command-${manifest.id}.tmp`);
  if (resolvedPath(temporary) !== temporary || !manifest.pendingCommand && lstatSync(temporary, { throwIfNoEntry: false })) throw new Error('The command staging path is occupied.');
  manifest.commandDirectories = [...new Set([...manifest.commandDirectories, ...missing])];
  manifest.pendingCommand = { schema: 'command-write-v1', definition, beforeDigest: before, temporary }; files.save(manifest);
  for (const path of missing) mkdirSync(path, { mode: 0o700 });
  atomicWrite(temporary, content, 0o755);
  try {
    if (before === null) linkSync(temporary, definition.path);
    else {
      if (currentDigest(definition.path) !== before) throw new Error('The command changed while its replacement was prepared.');
      renameSync(temporary, definition.path);
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  manifest.command = { schema: 'installed-command-v1', definition, digest: after }; delete manifest.pendingCommand; files.save(manifest);
}

export function removeCommand(files: InstallationFiles): void {
  const manifest = files.load();
  if (manifest.pendingCommand) throw new Error('Finish the pending command change before removing it.');
  if (manifest.command) {
    checkCommand(files, manifest.command.definition);
    if (currentDigest(manifest.command.definition.path) !== null) unlinkSync(manifest.command.definition.path);
    delete manifest.command; files.save(manifest);
  }
  const retained: string[] = [];
  for (const path of [...manifest.commandDirectories].reverse()) {
    if (resolvedPath(path) !== path) throw new Error('A command directory has changed outside Jevellan.');
    try { rmdirSync(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') retained.unshift(path);
      else if (code !== 'ENOENT') throw error;
    }
  }
  manifest.commandDirectories = retained; files.save(manifest);
}
