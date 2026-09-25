import { existsSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { readDocument, resolvedPath, writeDocument, type Homes } from '@jevellan/core';
import { HomePurgeSchema, InstallationManifestSchema, purgePaths, type InstallationFiles } from './installation-files.js';

function ownPath(path: string) { if (resolvedPath(path) !== path) throw new Error('A purge path changed outside Jevellan. Its files were preserved.'); }
export function recoverHomePurges(homes: Homes): void {
  const prefix = `${basename(homes.root)}.purge-`;
  for (const name of readdirSync(dirname(homes.root))) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const id = name.slice(prefix.length, -5); if (!z.uuid().safeParse(id).success) continue;
    const marker = join(dirname(homes.root), name); ownPath(marker);
    const manifest = readDocument(marker, InstallationManifestSchema), expected = purgePaths(homes.root, id);
    if (manifest.id !== id || manifest.home !== homes.root || manifest.dataRoot.path !== homes.root || manifest.pendingPurge?.path !== expected.path || manifest.pendingPurge.marker !== expected.marker || !manifest.pendingPurge.confirmed) throw new Error('A purge marker does not match this installation. It was preserved.');
    ownPath(expected.path);
    if (!existsSync(expected.path)) {
      const current = join(homes.root, 'install.json');
      if (existsSync(current) && InstallationManifestSchema.parse(JSON.parse(readFileSync(current, 'utf8'))).id === id) continue;
    } else rmSync(expected.path, { recursive: true });
    unlinkSync(marker);
  }
}

/** Caller holds maintenance and has stopped and removed the recorded service. */
export function stageHomePurge(files: InstallationFiles) {
  const manifest = files.load();
  if (manifest.service || manifest.pendingService || manifest.command || manifest.pendingCommand) throw new Error('Remove the stopped service and command before purging the home.');
  if (manifest.https && manifest.https.state !== 'removed') throw new Error('Remove the recorded HTTPS route before purging the home.');
  ownPath(files.homes.root); const paths = purgePaths(manifest.home, manifest.id); ownPath(paths.path); ownPath(paths.marker);
  if (existsSync(paths.path)) throw new Error('The purge destination is already occupied. It was preserved.');
  if (existsSync(paths.marker)) {
    const previous = readDocument(paths.marker, InstallationManifestSchema);
    if (previous.id !== manifest.id || previous.home !== manifest.home || previous.pendingPurge?.path !== paths.path || previous.pendingPurge.marker !== paths.marker) throw new Error('An existing purge marker belongs to another operation.');
  }
  const plan = HomePurgeSchema.parse({ schema: 'home-purge-v1', ...paths, confirmed: true }); manifest.pendingPurge = plan; files.save(manifest);
  writeDocument(plan.marker, InstallationManifestSchema, manifest);
  // A later install may create a fresh home after this rename. Cleanup only touches this recorded old copy.
  renameSync(files.homes.root, plan.path); return plan;
}
export function completeHomePurge(input: z.infer<typeof HomePurgeSchema>): void {
  const plan = HomePurgeSchema.parse(input); ownPath(plan.path); ownPath(plan.marker);
  rmSync(plan.path, { recursive: true, force: true }); unlinkSync(plan.marker);
}
