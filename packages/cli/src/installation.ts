import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DEFAULT_PORT, DeviceConfigSchema, DeviceOriginSchema, HealthSchema, Homes, JoinCodeSchema, LifecycleGate, MemberJoinPlanSchema, SecretRedactor, daemonRunning, lifecycleActivity, newId, readDocument, resolvedPath, writeDocument } from '@jevellan/core';
import { closeListeners, detectTailscaleIpv4, listenOnInterfaces } from '@jevellan/daemon';
import { joinMember } from '@jevellan/mesh';
import { InstallationFiles, applicationDigest, type InstalledApplication } from './installation-files.js';
import { installToolchain, type Toolchain } from './toolchain.js';
import { nativeServiceManager, type ServiceDefinition, type ServiceManager } from './service-manager.js';
import { completeHomePurge, recoverHomePurges, stageHomePurge } from './purge.js';
import { checkCommand, commandOnPath, commandPath, removeCommand, writeCommand } from './installed-command.js';
import { HttpsService, httpsOrigin } from './https-service.js';

export const InstallationResultSchema = z.strictObject({ schema: z.literal('installation-result-v1'), version: z.string(), url: z.url(), port: z.number().int(), changedPort: z.boolean(), command: z.string(), commandOnPath: z.boolean() });
export const InstallationJoinInputSchema = z.strictObject({ schema: z.literal('installation-join-input-v1'), hubUrl: DeviceOriginSchema, code: JoinCodeSchema });
export type InstallationJoinInput = z.infer<typeof InstallationJoinInputSchema>;
type Options = {
  homes?: Homes; manager?: ServiceManager; signal?: AbortSignal; progress?: (message: string) => void;
  installTools?: (files: InstallationFiles) => Promise<Toolchain>; tailscale?: () => Promise<string | null>;
  alive?: (homes: Homes) => boolean; ready?: (definition: ServiceDefinition, app: InstalledApplication) => Promise<void>;
  intervalMs?: number; joinFetch?: typeof fetch; commandSearchPath?: string; httpsService?: HttpsService;
};

/** Merely reserves and releases free listeners; it never stops another listener. */
export async function availablePort(first: number, tailscale: string | null): Promise<number> {
  z.number().int().min(1).max(65535).parse(first);
  for (let port = first; port <= 65535; port++) {
    try { const listeners = await listenOnInterfaces(() => createServer(), port, tailscale); await closeListeners(listeners.servers); return port; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No free Jevellan port is available.');
}

/** All service lifecycle actions originate in this user-invoked installer, never in the daemon. */
export class Installer {
  readonly homes: Homes;
  readonly files: InstallationFiles;
  readonly manager: ServiceManager;
  readonly https: HttpsService;
  readonly #gate: LifecycleGate;
  readonly #alive: (homes: Homes) => boolean;
  constructor(readonly options: Options = {}) {
    this.homes = options.homes ?? new Homes(); this.manager = options.manager ?? nativeServiceManager(); this.#alive = options.alive ?? daemonRunning; this.https = options.httpsService ?? new HttpsService();
    const definition = this.manager.definition({ schema: 'service-spec-v1', node: resolvedPath(process.execPath), entry: join(this.homes.root, 'app', 'pending', 'bin', 'jevellan.mjs'), home: this.homes.root, path: '/usr/bin:/bin', port: DEFAULT_PORT });
    this.files = new InstallationFiles(this.homes, definition.path);
    try { this.#gate = new LifecycleGate(this.homes); } catch (error) { this.files.close(); throw error; }
  }
  async #pause() { await delay(this.options.intervalMs ?? 500, undefined, this.options.signal ? { signal: this.options.signal } : {}); }
  async #idle(wait: boolean): Promise<() => void> {
    let previous = '';
    for (;;) {
      this.options.signal?.throwIfAborted(); const release = this.#gate.tryMaintenance(); if (release) return release;
      const conversations = [...new Map(lifecycleActivity(this.homes).filter(activity => activity.kind === 'conversation').map(activity => [activity.id, activity])).values()];
      if (!wait) throw new Error(conversations.length ? `Cannot uninstall while conversations are running: ${conversations.map(entry => entry.title ?? entry.id).join(', ')}` : 'Cannot uninstall while Jevellan is preparing or saving work. Try again when it is idle.');
      const message = conversations.length ? `Waiting for ${conversations.length} running conversations to finish` : 'Waiting for Jevellan to finish an active request';
      if (message !== previous) { this.options.progress?.(message); previous = message; }
      await this.#pause();
    }
  }
  async #stopped(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (this.#alive(this.homes)) { if (Date.now() >= deadline) throw new Error('The recorded Jevellan daemon has not stopped. Its application and data were preserved.'); await this.#pause(); }
  }
  async #ready(definition: ServiceDefinition, app: InstalledApplication): Promise<void> {
    if (this.options.ready) return this.options.ready(definition, app);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.options.signal?.throwIfAborted();
      try {
        if (this.#alive(this.homes)) {
          const response = await fetch(`http://127.0.0.1:${definition.spec.port}/api/health`, { signal: this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000) });
          const health = HealthSchema.parse(await response.json());
          if (response.ok && health.version === app.version) return;
        }
      } catch { this.options.signal?.throwIfAborted(); }
      await this.#pause();
    }
    throw new Error('Jevellan did not become ready. The pending installation is recorded; retry this command or roll back.');
  }
  async prepare(source: string): Promise<InstalledApplication> {
    this.options.signal?.throwIfAborted(); const app = this.files.copyApplication(source);
    const tools = await (this.options.installTools ?? (files => installToolchain(files, { ...(this.options.signal ? { signal: this.options.signal } : {}), ...(this.options.progress ? { progress: this.options.progress } : {}) })))(this.files);
    const manifest = this.files.load(), entry = manifest.applications.find(entry => entry.version === app.version)!;
    if (entry.toolchain && entry.toolchain !== tools.root) throw new Error('This application already has a different dependency environment.');
    entry.toolchain = tools.root; this.files.save(manifest); return entry;
  }
  validateJoin(input?: unknown): InstallationJoinInput | undefined {
    const target = input === undefined ? undefined : InstallationJoinInputSchema.parse(input), manifest = this.files.load();
    const device = existsSync(this.homes.at('device.json')) ? readDocument(this.homes.at('device.json'), DeviceConfigSchema) : undefined;
    const plan = existsSync(this.homes.at('join-pending.json')) ? readDocument(this.homes.at('join-pending.json'), MemberJoinPlanSchema) : undefined;
    if (!target && (plan || manifest.pendingSwitch?.join)) throw new Error('A member join is pending. Retry the original join command; this home will not become a hub.');
    if (target) {
      if (device?.role === 'hub' || existsSync(this.homes.at('hub'))) throw new Error('This home is a hub and cannot be converted into a member. Use a separate Jevellan home for the new device.');
      if (device && device.hubUrl !== target.hubUrl || plan && plan.hubUrl !== target.hubUrl || manifest.pendingSwitch?.join && manifest.pendingSwitch.join.hubUrl !== target.hubUrl) throw new Error('This home belongs to a different hub or pending join. Its files were preserved.');
      if (manifest.pendingSwitch && !manifest.pendingSwitch.join) throw new Error('A different installation is pending. Retry its original command before joining.');
    }
    return target;
  }
  async canOfferHttps() { return !this.files.load().https && !existsSync(this.homes.at('device.json')) && Boolean(await (this.options.tailscale ?? detectTailscaleIpv4)()); }
  async install(source: string, input?: unknown, https?: boolean) { const target = this.validateJoin(input); return this.#activate(await this.prepare(source), 'install', target, https); }
  async resumeJoin(input: unknown, https?: boolean) {
    const target = this.validateJoin(input); if (!target) return null;
    const manifest = this.files.load(), version = manifest.pendingSwitch?.join ? manifest.pendingSwitch.targetVersion : manifest.activeVersion;
    const app = manifest.applications.find(app => app.version === version);
    if (!app) return null;
    return this.#activate(app, 'install', target, https);
  }
  async update(source: string) {
    if (!this.files.load().activeVersion) throw new Error('Install Jevellan before updating it.');
    return this.#activate(await this.prepare(source), 'update');
  }
  async rollback() {
    const manifest = this.files.load(), app = manifest.applications.find(entry => entry.version === manifest.previousVersion);
    if (!app) throw new Error('There is no previous installed version to roll back to.');
    return this.#activate(app, 'rollback');
  }
  async #activate(app: InstalledApplication, operation: 'install' | 'update' | 'rollback', target?: InstallationJoinInput, https?: boolean) {
    this.validateJoin(target);
    let manifest = this.files.load();
    if (https === false && manifest.https) throw new Error('Keep this installation’s recorded HTTPS address. Its existing service was preserved.');
    if (applicationDigest(app.path) !== app.digest) throw new Error('The installed application changed. Its files were preserved.');
    const tools = manifest.toolchains.find(entry => entry.root === app.toolchain); if (!tools) throw new Error('Prepare this application’s dependencies before starting it.');
    if (manifest.pendingCommand) { writeCommand(this.files, manifest.pendingCommand.definition); manifest = this.files.load(); }
    if (!manifest.pendingSwitch && manifest.activeVersion === app.version && manifest.service && this.#alive(this.homes) && !(https && !manifest.https)) {
      if (manifest.https) { manifest.https = await this.https.enable(await this.https.plan(manifest.service.definition.spec.port, manifest.https)); this.files.save(manifest); }
      writeCommand(this.files, this.#command(manifest.service.definition));
      await this.#ready(manifest.service.definition, app); return this.#result(app, manifest.service.definition);
    }
    const tailscale = await (this.options.tailscale ?? detectTailscaleIpv4)();
    const pending = manifest.pendingSwitch?.targetVersion === app.version ? manifest.pendingSwitch : undefined;
    const devicePath = this.homes.at('device.json'), device = existsSync(devicePath) ? readDocument(devicePath, DeviceConfigSchema) : undefined;
    const joinPlan = existsSync(this.homes.at('join-pending.json')) ? readDocument(this.homes.at('join-pending.json'), MemberJoinPlanSchema) : undefined;
    const registered = device?.role === 'member' ? device.url : joinPlan?.device.url;
    if (registered?.startsWith('https://') && !manifest.https) throw new Error('This member’s HTTPS installation record is missing. Its registered address was preserved.');
    const registeredPort = registered?.startsWith('http://') ? Number(new URL(registered).port || 80) : undefined;
    const port = pending?.definition.spec.port ?? manifest.service?.definition.spec.port ?? manifest.https?.localPort ?? registeredPort ?? await availablePort(DEFAULT_PORT, tailscale);
    const route = https || manifest.https ? await this.https.plan(port, manifest.https) : undefined;
    const url = route ? httpsOrigin(route) : `http://${tailscale ?? '127.0.0.1'}:${port}`;
    if (registered && registered !== url) throw new Error('Keep this member’s registered address when installing it. Its current service was preserved.');
    const definition = pending?.definition ?? this.manager.definition({ schema: 'service-spec-v1', node: resolvedPath(process.execPath), entry: join(app.path, 'bin', 'jevellan.mjs'), home: this.homes.root, path: tools.path, port });
    const command = this.#command(definition); checkCommand(this.files, command);
    const release = await this.#idle(true);
    try {
      manifest = this.files.load();
      if (!manifest.service && this.#alive(this.homes)) throw new Error('Jevellan is running outside this installation’s recorded service. Stop that process before installing.');
      if (manifest.pendingSwitch && manifest.pendingSwitch.targetVersion !== app.version && operation !== 'rollback') throw new Error('A different service switch is pending. Retry its original command or roll back.');
      // Reconcile a written service whose receipt was lost before deciding which exact definition to stop.
      if (manifest.pendingService) { this.files.writeService(manifest.pendingService.definition); manifest = this.files.load(); }
      if (!manifest.pendingSwitch || manifest.pendingSwitch.targetVersion !== app.version) {
        manifest.pendingSwitch = { schema: 'service-switch-v1', operation, targetVersion: app.version, ...(manifest.activeVersion ? { fromVersion: manifest.activeVersion } : {}), definition, ...(target ? { join: { schema: 'installation-join-target-v1', hubUrl: target.hubUrl } as const } : {}) };
        this.files.save(manifest);
      }
      if (manifest.service) { await this.manager.stop(manifest.service.definition); await this.#stopped(); }
      this.homes.ensure('logs');
      if (route) {
        manifest = this.files.load(); manifest.https = { ...route, state: route.state === 'removed' ? 'pending' : route.state }; this.files.save(manifest);
        const enabled = await this.https.enable(manifest.https); manifest = this.files.load(); manifest.https = enabled; this.files.save(manifest);
      }
      if (target) {
        const redactor = new SecretRedactor(); redactor.add(target.code);
        try {
          this.options.signal?.throwIfAborted();
          await joinMember(this.homes, { schema: 'member-join-input-v1', hubUrl: target.hubUrl, code: target.code, device: { name: joinPlan?.device.name ?? device?.name ?? hostname(), url, os: process.platform, version: app.version } }, { redactor, ...(this.options.joinFetch ? { fetch: this.options.joinFetch } : {}) });
          this.options.signal?.throwIfAborted();
        } catch (error) { throw new Error(redactor.text(error instanceof Error ? error.message : 'Device joining could not complete. Retry the original command.')); }
      }
      if (!existsSync(devicePath)) writeDocument(devicePath, DeviceConfigSchema, { schema: 'device-config-v1', deviceId: newId('dev'), name: hostname(), role: 'hub', hubUrl: url, url, version: app.version });
      else {
        const device = readDocument(devicePath, DeviceConfigSchema);
        if (device.role === 'member' && device.url !== url) throw new Error('Keep this member’s registered address when reinstalling it.');
        writeDocument(devicePath, DeviceConfigSchema, { ...device, version: app.version, url, ...(device.role === 'hub' ? { hubUrl: url } : {}) });
      }
      this.files.writeService(definition); manifest = this.files.load();
      const from = manifest.pendingSwitch!.fromVersion;
      if (from && from !== app.version) manifest.previousVersion = from;
      manifest.activeVersion = app.version; this.files.save(manifest);
      writeCommand(this.files, command);
    } finally { release(); }
    await this.manager.start(definition); await this.#ready(definition, app);
    manifest = this.files.load(); delete manifest.pendingSwitch; this.files.save(manifest);
    return this.#result(app, definition);
  }
  #result(app: InstalledApplication, definition: ServiceDefinition) {
    const device = readDocument(this.homes.at('device.json'), DeviceConfigSchema);
    const command = this.files.load().command!.definition.path;
    return InstallationResultSchema.parse({ schema: 'installation-result-v1', version: app.version, url: device.url, port: definition.spec.port, changedPort: definition.spec.port !== DEFAULT_PORT, command, commandOnPath: commandOnPath(command, this.options.commandSearchPath) });
  }
  #command(definition: ServiceDefinition) {
    return { schema: 'command-definition-v1' as const, path: commandPath(this.files, this.options.commandSearchPath), node: definition.spec.node, entry: definition.spec.entry, home: this.homes.root };
  }
  async uninstall(): Promise<string> { return this.#remove(false); }
  async purge(confirmation: string): Promise<string> {
    if (confirmation !== this.homes.root) throw new Error('The path did not match. Nothing was removed.');
    return this.#remove(true);
  }
  async #remove(purge: boolean): Promise<string> {
    const release = await this.#idle(false);
    try {
      let manifest = this.files.load();
      if (!manifest.service && this.#alive(this.homes)) throw new Error('An unrecorded Jevellan process is still running. Its files were preserved.');
      if (manifest.pendingCommand) { writeCommand(this.files, manifest.pendingCommand.definition); manifest = this.files.load(); }
      if (manifest.command) checkCommand(this.files, manifest.command.definition);
      if (manifest.https && manifest.https.state !== 'removed') await this.https.check(manifest.https);
      if (manifest.pendingService) { this.files.writeService(manifest.pendingService.definition); manifest = this.files.load(); }
      if (manifest.service) { await this.manager.stop(manifest.service.definition); await this.#stopped(); }
      if (manifest.https && manifest.https.state !== 'removed') { manifest.https = await this.https.remove(manifest.https); this.files.save(manifest); }
      delete manifest.pendingSwitch; this.files.save(manifest);
      this.files.removeServiceDefinition(); await this.manager.removed();
      removeCommand(this.files);
      if (purge) {
        recoverHomePurges(this.homes); const plan = stageHomePurge(this.files);
        release(); this.close(); completeHomePurge(plan);
      } else { this.files.discardPreparedApplications(); this.files.removeApplications(); }
      return this.homes.root;
    } finally { release(); }
  }
  close(): void { try { this.#gate.close(); } finally { this.files.close(); } }
}
