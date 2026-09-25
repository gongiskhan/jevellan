import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DeviceConfigSchema, DeviceOriginSchema, Homes, atomicWrite, inside, readDocument, resolvedPath, writeDocument } from '@jevellan/core';
import { z } from 'zod';
import { ServiceDefinitionSchema, serviceContents, type ServiceDefinition } from './service-manager.js';
import { ToolchainPlanSchema, ToolchainSchema, toolchainDirectoryName, validateToolchain } from './toolchain.js';
import { InstalledCommandSchema, PendingCommandSchema, validateCommands } from './installed-command.js';
import { InstalledHttpsSchema } from './https-service.js';

const AbsolutePath = z.string().refine(isAbsolute);
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const InstalledApplicationSchema = z.strictObject({
  schema: z.literal('installed-application-v1'), version: Version, path: AbsolutePath,
  digest: Digest, installedAt: z.iso.datetime(),
  toolchain: AbsolutePath.optional(),
});
export type InstalledApplication = z.infer<typeof InstalledApplicationSchema>;
const CopySchema = z.strictObject({
  schema: z.literal('application-copy-v1'), id: z.uuid(), version: Version,
  staging: AbsolutePath, target: AbsolutePath, digest: Digest,
});
export const DistributionSchema = z.strictObject({ schema: z.literal('application-distribution-v1'), id: z.uuid(), path: AbsolutePath, source: z.string().min(1), createdAt: z.iso.datetime(), ready: z.boolean() });
export const HomePurgeSchema = z.strictObject({ schema: z.literal('home-purge-v1'), path: AbsolutePath, marker: AbsolutePath, confirmed: z.literal(true) });
export function purgePaths(home: string, id: string) {
  z.uuid().parse(id); const path = join(dirname(home), `${basename(home)}.purge-${id}`); return { path, marker: `${path}.json` };
}
export const InstallationManifestSchema = z.strictObject({
  schema: z.literal('installation-v1'), id: z.uuid(), home: AbsolutePath, createdAt: z.iso.datetime(),
  dataRoot: z.strictObject({ schema: z.literal('installed-data-root-v1'), path: AbsolutePath, retainedOnUninstall: z.literal(true) }),
  applications: z.array(InstalledApplicationSchema),
  distributions: z.array(DistributionSchema).default([]),
  service: z.strictObject({ schema: z.literal('installed-service-v1'), definition: ServiceDefinitionSchema, digest: Digest }).optional(),
  serviceDirectories: z.array(AbsolutePath),
  command: InstalledCommandSchema.optional(), pendingCommand: PendingCommandSchema.optional(), commandDirectories: z.array(AbsolutePath).default([]),
  https: InstalledHttpsSchema.optional(),
  activeVersion: Version.optional(), previousVersion: Version.optional(),
  pendingCopy: CopySchema.optional(),
  pendingService: z.strictObject({ schema: z.literal('service-write-v1'), beforeDigest: Digest.nullable(), temporary: AbsolutePath, definition: ServiceDefinitionSchema }).optional(),
  toolchains: z.array(ToolchainSchema).default([]), pendingTools: ToolchainPlanSchema.optional(),
  pendingSwitch: z.strictObject({ schema: z.literal('service-switch-v1'), operation: z.enum(['install', 'update', 'rollback']), targetVersion: Version, fromVersion: Version.optional(), definition: ServiceDefinitionSchema, join: z.strictObject({ schema: z.literal('installation-join-target-v1'), hubUrl: DeviceOriginSchema }).optional() }).optional(),
  pendingPurge: HomePurgeSchema.optional(),
});
export type InstallationManifest = z.infer<typeof InstallationManifestSchema>;
const PackageIdentity = z.object({ name: z.literal('jevellan'), version: Version, type: z.literal('module') });
const prohibited = new Set(['.git', '.claude', '.codex', 'BRIEF.md', 'CLAUDE.md', 'auth.json', '.env']);
const digestText = (text: string) => createHash('sha256').update(text).digest('hex');

/** Includes file bytes, executable bits and literal links; ignores timestamps. */
export function applicationDigest(root: string): string {
  const base = resolvedPath(root); const hash = createHash('sha256'); const chunk = Buffer.allocUnsafe(1024 * 1024);
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (prohibited.has(name)) throw new Error(`The application contains a protected path: ${name}. Use a packed Jevellan distribution.`);
      const path = join(directory, name), ref = relative(base, path), stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        if (isAbsolute(link) || !inside(base, resolvedPath(resolve(dirname(path), link)))) throw new Error('Application links must remain inside the installed copy.');
        hash.update(JSON.stringify(['link', ref, link]));
      } else if (stat.isDirectory()) { hash.update(JSON.stringify(['directory', ref])); walk(path); }
      else if (stat.isFile()) {
        hash.update(JSON.stringify(['file', ref, stat.mode & 0o111, stat.size]));
        const fd = openSync(path, 'r');
        try { for (;;) { const size = readSync(fd, chunk, 0, chunk.length, null); if (!size) break; hash.update(chunk.subarray(0, size)); } }
        finally { closeSync(fd); }
      } else throw new Error('The application contains an unsupported filesystem entry.');
    }
  };
  walk(base); return hash.digest('hex');
}

/** One SQLite transaction serializes installers and is released automatically on process exit. */
export class InstallationFiles {
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(readonly homes: Homes, readonly servicePath: string) {
    AbsolutePath.parse(servicePath);
    if (![join(homes.userHome, 'Library', 'LaunchAgents', 'dev.jevellan.daemon.plist'), join(homes.userHome, '.config', 'systemd', 'user', 'jevellan.service')].includes(servicePath)) throw new Error('Unexpected Jevellan service path.');
    if (existsSync(homes.root) && !existsSync(homes.at('install.json'))) {
      const entries = readdirSync(homes.root).filter(name => !['install-lock.db', 'install-lock.db-journal'].includes(name));
      if (entries.length) {
        if (!existsSync(homes.at('device.json'))) throw new Error('The chosen Jevellan home is not empty and has no installation or device record.');
        readDocument(homes.at('device.json'), DeviceConfigSchema);
      }
    }
    homes.ensure(); const lock = this.path('install-lock.db');
    try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    chmodSync(lock, 0o600); this.#db = new DatabaseSync(lock);
    try {
      this.#db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
      if (!existsSync(this.path('install.json'))) this.save({ schema: 'installation-v1', id: randomUUID(), home: homes.root, createdAt: new Date().toISOString(), dataRoot: { schema: 'installed-data-root-v1', path: homes.root, retainedOnUninstall: true }, applications: [], serviceDirectories: [], commandDirectories: [], toolchains: [], distributions: [] });
      this.load();
    } catch (error) { this.#db.close(); throw error; }
  }
  private path(...parts: string[]): string {
    const expected = join(this.homes.root, ...parts), actual = this.homes.at(...parts);
    if (actual !== expected) throw new Error('Installation paths cannot alias another location.');
    return actual;
  }
  private check(input: InstallationManifest): InstallationManifest {
    if (this.#closed) throw new Error('The installer is closed.');
    const value = InstallationManifestSchema.parse(input);
    if (value.home !== this.homes.root || value.dataRoot.path !== value.home) throw new Error('This installation manifest belongs to another home.');
    validateCommands(this.homes, value);
    if (value.pendingPurge) {
      const expected = purgePaths(value.home, value.id);
      if (value.pendingPurge.path !== expected.path || value.pendingPurge.marker !== expected.marker) throw new Error('The pending purge does not belong to this installation.');
    }
    for (const tools of value.toolchains) validateToolchain(this.homes, tools);
    if (new Set(value.toolchains.map(tools => tools.root)).size !== value.toolchains.length) throw new Error('The installation contains duplicate toolchains.');
    if (value.pendingTools && value.pendingTools.root !== this.path('tools', toolchainDirectoryName(value.pendingTools))) throw new Error('The pending toolchain belongs to another installation.');
    if (new Set(value.applications.map(app => app.version)).size !== value.applications.length) throw new Error('The installation contains duplicate versions.');
    if (new Set(value.distributions.map(entry => entry.id)).size !== value.distributions.length || value.distributions.some(entry => entry.path !== this.path('distributions', entry.id))) throw new Error('A prepared distribution does not belong to this installation.');
    for (const app of value.applications) if (app.path !== this.path('app', app.version)) throw new Error('An application path does not belong to this installation.');
    for (const app of value.applications) if (app.toolchain && !value.toolchains.some(tools => tools.root === app.toolchain)) throw new Error('The application refers to an unrecorded toolchain.');
    for (const version of [value.activeVersion, value.previousVersion]) if (version && !value.applications.some(app => app.version === version)) throw new Error('The selected application version is not installed.');
    if (value.pendingSwitch && !value.applications.some(app => app.version === value.pendingSwitch!.targetVersion && join(app.path, 'bin', 'jevellan.mjs') === value.pendingSwitch!.definition.spec.entry)) throw new Error('The pending service version is not installed.');
    if (value.pendingCopy && (value.pendingCopy.target !== this.path('app', value.pendingCopy.version) || value.pendingCopy.staging !== this.path('staging', value.pendingCopy.id))) throw new Error('The pending application copy has an unexpected path.');
    if (value.service && (value.service.definition.path !== this.servicePath || value.service.digest !== digestText(serviceContents(value.service.definition)))) throw new Error('The recorded service does not match this installation.');
    for (const definition of [value.service?.definition, value.pendingService?.definition, value.pendingSwitch?.definition]) if (definition && (definition.path !== this.servicePath || definition.spec.home !== this.homes.root || !value.applications.some(app => definition.spec.entry === join(app.path, 'bin', 'jevellan.mjs')))) throw new Error('The service must run a recorded installed application.');
    if (value.pendingService && value.pendingService.temporary !== join(dirname(this.servicePath), `.jevellan-service-${value.id}.tmp`)) throw new Error('The service staging file has an unexpected path.');
    for (const directory of value.serviceDirectories) if (directory === this.homes.userHome || !inside(this.homes.userHome, directory) || !inside(directory, this.servicePath) || directory === this.servicePath) throw new Error('A service directory does not belong to this installation.');
    return value;
  }
  load(): InstallationManifest { return this.check(readDocument(this.path('install.json'), InstallationManifestSchema)); }
  save(value: InstallationManifest): InstallationManifest { return writeDocument(this.path('install.json'), InstallationManifestSchema, this.check(value)); }
  createDistribution(source: string) {
    const id = randomUUID(), manifest = this.load();
    const entry = DistributionSchema.parse({ schema: 'application-distribution-v1', id, path: this.path('distributions', id), source, createdAt: new Date().toISOString(), ready: false });
    manifest.distributions.push(entry); this.save(manifest); this.homes.ensure('distributions', id); return entry;
  }
  removeDistribution(id: string): void {
    const manifest = this.load(), entry = manifest.distributions.find(entry => entry.id === id); if (!entry) return;
    rmSync(entry.path, { recursive: true, force: true }); manifest.distributions = manifest.distributions.filter(entry => entry.id !== id); this.save(manifest);
  }
  copyApplication(source: string): InstalledApplication {
    const base = resolvedPath(source);
    const ownedDistribution = this.load().distributions.some(entry => entry.ready && base === this.path('distributions', entry.id, 'package'));
    if (inside(base, this.homes.root) || inside(this.homes.root, base) && !ownedDistribution) throw new Error('The source application and installed home must be separate.');
    const identity = PackageIdentity.parse(JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')));
    for (const file of ['bin/jevellan.mjs', 'packages/cli/dist/index.js', 'apps/web/dist/index.html']) if (!existsSync(join(base, file))) throw new Error('Build and pack Jevellan before installing it.');
    const digest = applicationDigest(base); let manifest = this.load();
    const existing = manifest.applications.find(app => app.version === identity.version);
    if (existing) {
      if (existing.digest !== digest || applicationDigest(existing.path) !== digest) throw new Error('This version already exists with different contents. Give the new application a new version.');
      return existing;
    }
    let pending = manifest.pendingCopy;
    if (pending && (pending.version !== identity.version || pending.digest !== digest)) throw new Error('A different application copy is pending. Retry its original distribution.');
    if (!pending) {
      const id = randomUUID(); const target = this.path('app', identity.version);
      if (existsSync(target)) throw new Error('An unrecorded application already occupies this version directory.');
      pending = CopySchema.parse({ schema: 'application-copy-v1', id, version: identity.version, staging: this.path('staging', id), target, digest });
      manifest.pendingCopy = pending; this.save(manifest);
    }
    if (!existsSync(pending.target)) {
      if (existsSync(pending.staging)) rmSync(pending.staging, { recursive: true });
      mkdirSync(dirname(pending.staging), { recursive: true, mode: 0o700 });
      cpSync(base, pending.staging, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      if (applicationDigest(pending.staging) !== digest) throw new Error('The application changed while it was copied. Retry a stable distribution.');
      mkdirSync(dirname(pending.target), { recursive: true, mode: 0o700 }); renameSync(pending.staging, pending.target);
    }
    if (applicationDigest(pending.target) !== digest) throw new Error('The pending installed application does not match its recorded contents.');
    const installed = InstalledApplicationSchema.parse({ schema: 'installed-application-v1', version: identity.version, path: pending.target, digest, installedAt: new Date().toISOString() });
    manifest = this.load(); manifest.applications.push(installed); delete manifest.pendingCopy; this.save(manifest); return installed;
  }
  writeService(definition: ServiceDefinition): void {
    const next = ServiceDefinitionSchema.parse(definition); const manifest = this.load();
    if (next.path !== this.servicePath || resolvedPath(next.path) !== next.path || next.spec.home !== this.homes.root) throw new Error('The service does not belong to this installation.');
    if (!manifest.applications.some(app => next.spec.entry === join(app.path, 'bin', 'jevellan.mjs'))) throw new Error('The service must run a recorded installed application.');
    const content = serviceContents(next), afterDigest = digestText(content);
    if (manifest.pendingService && digestText(serviceContents(manifest.pendingService.definition)) !== afterDigest) throw new Error('A different service change is pending. Retry its original definition.');
    const existingDigest = existsSync(next.path) ? digestText(readFileSync(next.path, 'utf8')) : null;
    if (manifest.pendingService && existingDigest === afterDigest) {
      const temporary = manifest.pendingService.temporary;
      if (resolvedPath(temporary) !== temporary) throw new Error('The service staging path has changed.');
      if (existsSync(temporary)) unlinkSync(temporary);
      manifest.service = { schema: 'installed-service-v1', definition: next, digest: afterDigest }; delete manifest.pendingService; this.save(manifest); return;
    }
    if (existingDigest !== (manifest.pendingService?.beforeDigest ?? manifest.service?.digest ?? null)) throw new Error('The existing service was changed outside Jevellan.');
    const missing: string[] = []; let directory = dirname(next.path);
    while (!existsSync(directory)) { missing.unshift(directory); directory = dirname(directory); }
    for (const path of missing) if (!inside(this.homes.userHome, path)) throw new Error('Service directories must be inside the user home.');
    // Record created directories before touching them; empty-only removal preserves unrelated files.
    manifest.serviceDirectories = [...new Set([...manifest.serviceDirectories, ...missing])];
    const temporary = join(dirname(next.path), `.jevellan-service-${manifest.id}.tmp`);
    if (resolvedPath(temporary) !== temporary) throw new Error('The service staging path has changed.');
    manifest.pendingService = { schema: 'service-write-v1', beforeDigest: existingDigest, temporary, definition: next }; this.save(manifest);
    for (const path of missing) mkdirSync(path, { mode: 0o700 });
    atomicWrite(temporary, content);
    try {
      if (existingDigest === null) linkSync(temporary, next.path);
      else {
        if (digestText(readFileSync(next.path, 'utf8')) !== existingDigest) throw new Error('The service changed while its replacement was prepared.');
        renameSync(temporary, next.path);
      }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    manifest.service = { schema: 'installed-service-v1', definition: next, digest: afterDigest }; delete manifest.pendingService; this.save(manifest);
  }
  /** The lifecycle coordinator must stop the recorded service before removing its definition. */
  removeServiceDefinition(): void {
    const manifest = this.load();
    if (manifest.pendingService) throw new Error('Finish the pending service change before removing it.');
    if (manifest.service) {
      const path = manifest.service.definition.path;
      if (resolvedPath(path) !== path) throw new Error('The service path has changed outside Jevellan.');
      if (existsSync(path)) {
        if (digestText(readFileSync(path, 'utf8')) !== manifest.service.digest) throw new Error('The service definition has changed outside Jevellan.');
        unlinkSync(path);
      }
      delete manifest.service; this.save(manifest);
    }
    const retained: string[] = [];
    for (const path of [...manifest.serviceDirectories].reverse()) {
      if (resolvedPath(path) !== path) throw new Error('A service directory has changed outside Jevellan.');
      try { rmdirSync(path); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') retained.unshift(path);
        else if (code !== 'ENOENT') throw error;
      }
    }
    manifest.serviceDirectories = retained; this.save(manifest);
  }
  removeApplications(): void {
    const manifest = this.load();
    if (manifest.service || manifest.pendingService || manifest.pendingCopy || manifest.pendingSwitch || manifest.command || manifest.pendingCommand) throw new Error('Finish pending copies and remove the stopped service and command before removing applications.');
    // Check all versions before deleting any. Out-of-band additions or edits are preserved.
    for (const app of manifest.applications) if (existsSync(app.path) && applicationDigest(app.path) !== app.digest) throw new Error('An installed application changed outside Jevellan. Its files were preserved.');
    for (const app of manifest.applications) if (existsSync(app.path)) rmSync(app.path, { recursive: true });
    manifest.applications = []; delete manifest.activeVersion; delete manifest.previousVersion; this.save(manifest);
  }
  discardPreparedApplications(): void {
    const manifest = this.load();
    if (manifest.service || manifest.pendingService || manifest.pendingSwitch) throw new Error('Remove the stopped service before discarding prepared applications.');
    if (manifest.pendingCopy) {
      const pending = manifest.pendingCopy;
      if (existsSync(pending.target) && applicationDigest(pending.target) !== pending.digest) throw new Error('A prepared application changed outside Jevellan. Its files were preserved.');
      rmSync(pending.staging, { recursive: true, force: true }); rmSync(pending.target, { recursive: true, force: true });
      delete manifest.pendingCopy;
    }
    for (const entry of manifest.distributions) rmSync(entry.path, { recursive: true, force: true });
    manifest.distributions = []; this.save(manifest);
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    try { this.#db.exec('ROLLBACK'); } finally { this.#db.close(); }
  }
}
