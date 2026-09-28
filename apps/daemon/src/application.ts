import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { z } from 'zod';
import { ConsumeSwitchSchema, DaemonOwnership, DeviceConfigSchema, DeviceOriginSchema, DeviceSchema, DeviceSwitchInputSchema, JevConnectionSchema, RiggingApplicationSchema, Homes, ProjectVisibility, RiggingDisk, SecretRedactor, VERSION, newId, readDocument, seedConfiguration, stableJson, writeDocument, type DeviceConfig, type Project, type VisibilityProbe } from '@jevellan/core';
import { DeviceRegistry, HubAccounts, HubCheckoutStore, HubDatabase, HubIndexes, HubMesh, HubPublicationLeases, HubState, MemberAccounts, MemberCheckoutStore, MemberHubClient, MemberIndexes, MemberPublicationLeases, MemberState, MemberUiAuth, ProjectImproverHub, UiAuth, memberConnection } from '@jevellan/mesh';
import { AccountService } from '@jevellan/accounts';
import { BackgroundDrafts, ContextOperations, ConversationService, StretchBridges } from '@jevellan/conversations';
import { RoutingImprover } from './routing-improver.js';
import { Improver } from './improver.js';
import { ProjectImprover, type MemoryPort } from './project-improver.js';
import { migrateContextOperations } from './context-migration.js';
import { BasicMemory } from '@jevellan/memory';
import { JevClient, JevError } from '@jevellan/decisions';
import { createRuntime as createClaude } from '@jevellan/runtime-claude';
import { createRuntime as createCodex, prepareApiKey } from '@jevellan/runtime-codex';
import type { RuntimeAdapter, RuntimeContext } from '@jevellan/runtime-contract';
import { materialiseConfiguration, type SharedRigging } from '@jevellan/core';
import { CursorSessions, DevicePresence, ExternalSessionSensor, type SessionSensorOptions } from '@jevellan/mesh';
import { SettingsSync } from './settings-sync.js';
import { LifecycleGate } from '@jevellan/core';

export type ApplicationOptions = { homes?: Homes; port?: number; url?: string; runtimes?: (context: RuntimeContext) => ReadonlyMap<string, RuntimeAdapter>; timers?: boolean; repositoryVisibility?: VisibilityProbe; decisionFetch?: typeof fetch; hubFetch?: typeof fetch; nativeSessions?: Omit<SessionSensorOptions, 'homes'>;
  /** Test seam for the improver's memory index; production uses the isolated Basic Memory. */ projectMemory?: (project: Project) => MemoryPort };

export class Application {
  #closing: Promise<void> | undefined;
  #configurationRevision = 0;
  #riggingQueue: Promise<unknown> = Promise.resolve();
  readonly #ownership: DaemonOwnership;
  readonly lifecycle: LifecycleGate;
  /** Resolves once startup recovery is complete and the startup lifecycle activity is released. */
  readonly started: Promise<void>;
  readonly #hub: HubDatabase | undefined;
  readonly #mesh: HubMesh | undefined;
  readonly homes: Homes; readonly device: DeviceConfig; readonly redactor: SecretRedactor;
  readonly member: MemberHubClient | undefined;
  readonly accounts: AccountService; readonly auth: UiAuth | MemberUiAuth; readonly rigging: SharedRigging;
  readonly bridges: StretchBridges;
  readonly memory: BasicMemory; readonly conversations: ConversationService;
  readonly projectVisibility: ProjectVisibility;
  readonly state: HubState | MemberState;
  readonly riggingDisk: RiggingDisk;
  readonly decisionClient: () => Promise<JevClient>;
  readonly runtimes: ReadonlyMap<string, RuntimeAdapter>;
  readonly sessions: ExternalSessionSensor;
  readonly cursor: CursorSessions;
  readonly presence: DevicePresence;
  readonly settingsSync: SettingsSync;
  readonly backgroundDrafts: BackgroundDrafts;
  readonly routingImprover: RoutingImprover | undefined;
  readonly improver: Improver | undefined;
  readonly projectImprover: ProjectImprover;
  readonly #improverTimers: boolean;
  get hub(): HubDatabase { if (!this.#hub) throw new Error('A member has no authoritative hub database.'); return this.#hub; }
  get mesh(): HubMesh { if (!this.#mesh) throw Object.assign(new Error('This operation belongs to the hub.'), { status: 404 }); return this.#mesh; }
  get devices(): DeviceRegistry { return this.mesh.devices; }
  get hubAuth(): UiAuth { return this.mesh.auth; }
  constructor(options: ApplicationOptions = {}) {
    this.#improverTimers = options.timers !== false;
    this.projectVisibility = new ProjectVisibility(options.repositoryVisibility);
    this.homes = options.homes ?? new Homes(); this.homes.ensure();
    this.#ownership = new DaemonOwnership(this.homes);
    let lifecycle: LifecycleGate | undefined; let startup: (() => void) | undefined;
    try {
    this.lifecycle = lifecycle = new LifecycleGate(this.homes); startup = lifecycle.enter({ kind: 'startup' });
    const devicePath = this.homes.at('device.json'); const url = DeviceOriginSchema.parse(options.url ?? `http://127.0.0.1:${options.port ?? 9771}`);
    if (!existsSync(devicePath) && ['join-pending.json', 'device.token', 'ui-auth.json', 'hub-device.json'].some(name => existsSync(this.homes.at(name)))) throw new Error('Finish the pending member join before starting this home.');
    this.device = existsSync(devicePath) ? readDocument(devicePath, DeviceConfigSchema) : writeDocument(devicePath, DeviceConfigSchema, { schema: 'device-config-v1', deviceId: newId('dev'), name: hostname(), role: 'hub', hubUrl: url, url, version: VERSION });
    this.#hub = undefined; this.#mesh = undefined; this.member = undefined;
    if (this.device.role === 'member') {
      if (existsSync(this.homes.at('hub'))) throw new Error('A member cannot open a home containing an authoritative hub database.');
      this.redactor = new SecretRedactor();
      const connection = memberConnection(this.homes, { redactor: this.redactor, ...(options.hubFetch ? { fetch: options.hubFetch } : {}) });
      this.member = connection.client; this.auth = connection.auth;
    } else {
      this.#hub = new HubDatabase(this.homes, 'hub'); this.redactor = this.#hub.redactor;
      this.auth = new UiAuth(this.#hub, this.#hub.vault, this.device.deviceId);
    }
    try {
      const contexts = new ContextOperations(this.homes);
      if (this.#hub) {
        if (!this.#hub.configuration.current()) this.#hub.configuration.put(seedConfiguration(), 0, { deviceId: this.device.deviceId, source: 'install' });
        this.#hub.configuration.materialise(this.homes);
        const localDevice = this.#hub.get('devices', this.device.deviceId, DeviceSchema);
        if (!localDevice) this.#hub.put('devices', this.device.deviceId, DeviceSchema, { schema: 'device-v1', id: this.device.deviceId, name: this.device.name, role: 'hub', url: this.device.url, os: process.platform, version: VERSION, joinedAt: new Date().toISOString() }, 0);
        else if (localDevice.document.url !== this.device.url || localDevice.document.version !== VERSION) this.#hub.put('devices', this.device.deviceId, DeviceSchema, { ...localDevice.document, url: this.device.url, version: VERSION }, localDevice.revision);
        if (this.auth instanceof UiAuth) this.#mesh = new HubMesh(this.#hub, new DeviceRegistry(this.#hub, this.device.deviceId), this.auth);
        migrateContextOperations(this.#hub, this.homes, this.device.deviceId, contexts);
        const old = this.#hub.get('rigging-application', this.device.deviceId, RiggingApplicationSchema);
        if (old) {
          const local = this.riggingApplication();
          if (local && stableJson(local) !== stableJson(old.document)) throw new Error('Local and shared rigging receipts differ. Preserve both copies before recovery.');
          writeDocument(this.homes.at('rigging', 'application.json'), RiggingApplicationSchema, old.document);
          this.#hub.db.prepare("DELETE FROM documents WHERE namespace='rigging-application' AND id=?").run(this.device.deviceId);
        }
      }
      const context: RuntimeContext = { homes: this.homes, daemonPid: process.pid, redactor: this.redactor, saveSecret: async (id, value, requestId) => { await this.accounts.captureSecret(id, value, undefined, requestId); } };
      this.runtimes = options.runtimes?.(context) ?? new Map([['claude', createClaude(context)], ['codex', createCodex(context)]]);
      this.state = this.member ? new MemberState(this.member, [...this.runtimes.keys()]) : new HubState(this.hub, this.device.deviceId, [...this.runtimes.keys()]); this.rigging = this.state.rigging;
      this.riggingDisk = new RiggingDisk(this.homes, this.redactor);
      this.bridges = new StretchBridges(this.redactor);
      this.memory = new BasicMemory(this.homes, 'basic-memory', this.redactor);
      this.sessions = new ExternalSessionSensor({ ...options.nativeSessions, homes: this.homes });
      this.cursor = new CursorSessions(this.homes, this.device.deviceId, this.device.name);
      this.accounts = new AccountService({ store: this.member ? new MemberAccounts(this.member) : new HubAccounts(this.hub, this.device.deviceId), redactor: this.redactor, homes: this.homes, deviceId: this.device.deviceId, runtimes: this.runtimes,
        configurationChanged: async () => { await this.configuration(); },
        ...(!options.runtimes ? { prepare: async (account) => { if (account.account.runtime === 'codex' && account.account.kind === 'api-key') await prepareApiKey(account, context); } } : {}),
        ...(options.timers === undefined ? {} : { timers: options.timers }),
      });
      this.decisionClient = async () => new JevClient({ key: () => this.state.jev.credential(), timeoutMs: (await this.configuration()).configuration['x-jevellan'].decisions.timeoutMs, ...(options.decisionFetch ? { fetch: options.decisionFetch } : {}) });
      const accountRuns = new Set<string>();
      const leases = this.member ? new MemberPublicationLeases(this.member) : new HubPublicationLeases(this.hub, this.device.deviceId);
      this.conversations = new ConversationService({ homes: this.homes, contexts, projects: this.state.projects, deviceId: this.device.deviceId, accounts: this.accounts, runtimes: this.runtimes,
        coordination: this.member ? new MemberCheckoutStore(this.member) : new HubCheckoutStore(this.hub, this.device.deviceId), leases, indexes: this.member ? new MemberIndexes(this.member) : new HubIndexes(this.hub, this.device.deviceId),
        bridges: this.bridges, memory: this.memory, redactor: this.redactor, settings: async () => (await this.configuration()).configuration['x-jevellan'], riggingItems: (runtime) => this.rigging.items(runtime),
        deviceLabel: this.device.name, jevAvailable: async () => (await this.state.jev.summary()).saved, externalSessions: (projects, deviceId) => this.sessions.read(projects, deviceId),
        decisionClient: this.decisionClient, accountRuns, enterOperation: (id, title) => this.lifecycle.enter({ kind: 'conversation', id, title }) });
      this.backgroundDrafts = new BackgroundDrafts({ homes: this.homes, deviceId: this.device.deviceId, accounts: this.accounts, runtimes: this.runtimes, bridges: this.bridges,
        redactor: this.redactor, settings: async () => (await this.configuration()).configuration['x-jevellan'], riggingItems: runtime => this.rigging.items(runtime),
        accountRuns, enterOperation: (id, title) => this.lifecycle.enter({ kind: 'settings', id, title }) });
      const improverReady = Promise.all([this.conversations.ready, this.backgroundDrafts.ready]).then(() => undefined);
      const hub = this.#hub; const mesh = this.#mesh;
      this.improver = hub && mesh ? new Improver({ hub, deviceId: this.device.deviceId, ready: improverReady,
        client: this.decisionClient, draft: (request, signal) => this.backgroundDrafts.run(request, signal),
        evidence: options.decisionFetch || options.runtimes ? 'simulated' : 'live', enterOperation: (id, title) => this.lifecycle.enter({ kind: 'settings', id, title }),
        projects: new ProjectImproverHub(hub, { hubId: this.device.deviceId, devices: () => mesh.devices.list() }), kick: () => { void this.projectImprover.tick().catch(() => undefined); } }) : undefined;
      this.routingImprover = this.improver;
      const improver = this.improver;
      this.projectImprover = new ProjectImprover({ deviceId: this.device.deviceId, deviceName: this.device.name, homes: this.homes, redactor: this.redactor, ready: improverReady,
        hub: async input => this.member ? this.member.improverDevice(input) : improver!.projects.request(this.device.deviceId, input),
        projects: async () => (await this.state.projects.list()).map(row => row.project), ownership: this.conversations.ownership, leases,
        assertOutsideIdle: async (project, path) => this.conversations.outside.assertIdle(project, path, (await this.configuration()).configuration['x-jevellan'].guards.externalActivityWindowMin),
        memory: options.projectMemory ?? (project => {
          const memory = this.memory.project(project, this.device.deviceId, () => { throw new Error('Memory care reads the index only.'); });
          return { sync: async () => { await memory.sync(); }, search: async (query, signal) => (await memory.search(query, signal)).notes };
        }),
        client: this.decisionClient, jevModel: async () => (await this.configuration()).configuration['x-jevellan'].decisions.model,
        draft: (request, signal) => this.backgroundDrafts.run(request, signal), handoffs: projectId => this.conversations.recentHandoffSummaries(projectId),
        enterOperation: (id, title) => this.lifecycle.enter({ kind: 'settings', id, title }), pollMs: this.member ? 15_000 : 60_000 });
      this.presence = new DevicePresence({ deviceId: this.device.deviceId, version: VERSION, sensor: this.sessions,
        projects: async () => (await this.state.projects.list()).map(row => row.project), running: () => this.conversations.localRunning(),
        report: async heartbeat => {
          await this.conversations.checkExternalActivity();
          const result = await (this.member ? this.member.heartbeat(heartbeat) : this.devices.heartbeat(this.device.deviceId, heartbeat));
          this.conversations.hubWaits.reachable(); return result;
        }, ready: this.conversations.ready,
        ...(options.timers === undefined ? {} : { timers: options.timers }) });
      this.settingsSync = new SettingsSync({ homes: this.homes, redactor: this.redactor, ready: this.conversations.ready, apply: () => this.applyRigging(), ...(options.timers === undefined ? {} : { timers: options.timers }) });
      const releaseStartup = startup; startup = undefined;
      this.started = improverReady.then(releaseStartup, releaseStartup).catch(() => undefined);
    } catch (error) { this.#hub?.close(); throw error; }
    } catch (error) { startup?.(); lifecycle?.close(); this.#ownership.close(); throw error; }
  }
  bindDaemonUrl(url: string): void {
    this.conversations.daemonUrl = url; this.backgroundDrafts.daemonUrl = url;
    if (this.#improverTimers) { this.routingImprover?.start(); this.projectImprover.start(); }
  }
  async improverRequest(input: unknown) { return this.member ? this.member.improver(input) : this.routingImprover!.request(input, this.device.deviceId); }
  async configuration() {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#closing) throw Object.assign(new Error('Jevellan is stopping.'), { status: 503 });
      const revision = await this.state.configuration.current();
      if (this.#closing) throw Object.assign(new Error('Jevellan is stopping.'), { status: 503 });
      if (revision.revision < this.#configurationRevision) continue;
      const materialised = materialiseConfiguration(this.homes, revision); this.#configurationRevision = revision.revision; return materialised;
    }
    throw Object.assign(new Error('Settings changed while loading. Reload the latest version.'), { status: 409 });
  }
  async roster() { return this.member ? this.member.devices() : this.mesh.roster(this.device.deviceId); }
  async inviteDevice() { return this.member ? this.member.invite() : this.mesh.invite(); }
  async switchDevice(input: unknown) { return this.member ? this.member.issueSwitch(input) : this.devices.issueSwitch(this.device.deviceId, DeviceSwitchInputSchema.parse(input)); }
  async consumeSwitch(input: unknown) { return this.auth instanceof MemberUiAuth ? this.auth.consumeSwitch(input) : this.mesh.consumeSwitch(this.device.deviceId, ConsumeSwitchSchema.parse(input).token); }
  async streamAuthenticated(token: string | undefined) { return this.auth instanceof MemberUiAuth ? this.auth.verifyStream(token) : !!this.auth.verify(token); }
  async peerAuthenticated(input: unknown, existingStream = false) { return this.auth instanceof MemberUiAuth ? this.auth.verifyPeer(input, existingStream) : !!this.mesh.peerSession(this.device.deviceId, input).session; }
  async peerLoginAuthenticated(input: unknown) { return this.auth instanceof MemberUiAuth ? this.auth.verifyPeerLogin(input) : !!this.mesh.peerLoginSession(this.device.deviceId, input).session; }
  riggingApplication() { const path = this.homes.at('rigging', 'application.json'); return existsSync(path) ? readDocument(path, RiggingApplicationSchema) : null; }
  async checkJev(signal?: AbortSignal) {
    const configuredModel = (await this.configuration()).configuration['x-jevellan'].decisions.model;
    const started = performance.now();
    try {
      const result = await (await this.decisionClient()).models(signal);
      return JevConnectionSchema.parse({ schema: 'jev-connection-v2', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started), configuredModel, status: 'connected', availableModels: result.models.map((model) => model.name) });
    } catch (error) {
      if (!(error instanceof JevError)) throw error;
      return JevConnectionSchema.parse({ schema: 'jev-connection-v2', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started), configuredModel, status: 'unavailable', availableModels: [], reason: error.message });
    }
  }
  applyRigging() {
    const task = this.#riggingQueue.catch(() => undefined).then(async () => {
      const release = this.lifecycle.enter({ kind: 'settings' });
      try { return await this.#applyRigging(); } finally { release(); }
    });
    this.#riggingQueue = task; return task;
  }
  async #applyRigging() {
    await this.configuration();
    const results: z.infer<typeof RiggingApplicationSchema>['accounts'] = [];
    for (const { account } of await this.accounts.list()) {
      if (this.#closing) throw Object.assign(new Error('Jevellan is stopping.'), { status: 503 });
      const runtime = this.runtimes.get(account.runtime);
      if (!runtime) { results.push({ accountId: account.id, runtime: account.runtime, results: [], error: 'This runtime is not installed.' }); continue; }
      try { results.push({ accountId: account.id, runtime: account.runtime, results: await runtime.materialiseRigging(this.homes.account(account.runtime, account.id), await this.rigging.items(account.runtime)) }); }
      catch (error) { results.push({ accountId: account.id, runtime: account.runtime, results: [], error: this.redactor.text(error instanceof Error ? error.message : 'Rigging could not be applied.') }); }
    }
    const value = RiggingApplicationSchema.parse({ schema: 'rigging-application-v1', at: new Date().toISOString(), accounts: results });
    writeDocument(this.homes.at('rigging', 'application.json'), RiggingApplicationSchema, value);
    return value;
  }
  close(): Promise<void> { return this.#closing ??= (async () => {
    const failures: unknown[] = [];
    try { await this.settingsSync.close(); await this.#riggingQueue.catch(() => undefined); } catch (error) { failures.push(error); }
    try { await this.presence.close(); } catch (error) { failures.push(error); }
    try { await this.projectImprover.close(); } catch (error) { failures.push(error); }
    try { await this.routingImprover?.close(); } catch (error) { failures.push(error); }
    try { await this.backgroundDrafts.close(); } catch (error) { failures.push(error); }
    try { await this.conversations.close(); } catch (error) { failures.push(error); }
    const cleanup = await Promise.allSettled([this.accounts.close(), this.bridges.close(), this.memory.close()]);
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason);
    try { this.#hub?.close(); } catch (error) { failures.push(error); }
    try { this.lifecycle.close(); } catch (error) { failures.push(error); }
    try { this.#ownership.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Application cleanup did not complete.');
  })(); }
}

export { RiggingApplicationSchema } from '@jevellan/core';
