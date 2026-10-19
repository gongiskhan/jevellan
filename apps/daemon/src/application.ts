import { CleanupService } from '@jevellan/core';
import { ProjectHealthRequestSchema, ProjectHealthRunSchema, ProjectHealthViewSchema, type ProjectHealthRequest, type ProjectHealthRun } from '@jevellan/core';
import { runHealthCheck } from '@jevellan/projects';
import { ProjectLibraryService } from './library.js';
import { HubNotifications, type PushSend } from './notifications.js';
import { NotificationOwnerRequestSchema } from '@jevellan/core';
import { EkoaMirrorService } from './ekoa-mirror.js';
import { OwnerTools } from './owner-tools.js';
import { OwnerEvents } from './owner-events.js';
import { OwnerPushes } from './owner-pushes.js';
import { OwnerBridges } from './owner-bridge.js';
import type { EkoaConnector } from './ekoa-client.js';
import { collectDeviceFacts, EkoaRequestSchema, DeviceSettingsInputSchema, DeviceTagsInputSchema, type DeviceFacts } from '@jevellan/core';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { z } from 'zod';
import { ConsumeSwitchSchema, DaemonOwnership, DeviceConfigSchema, DeviceOriginSchema, DeviceSchema, DeviceSwitchInputSchema, JevConnectionSchema, RiggingApplicationSchema, GitHubClient, ProjectSchema, VaultProjectSchema, VaultViewSchema, Homes, ProjectVisibility, RiggingDisk, SecretRedactor, VERSION, compareVersions, versionSkewMessage, newId, readDocument, seedConfiguration, stableJson, writeDocument, type DeviceConfig, type VaultView, type Project, type ProjectHub, type VisibilityProbe } from '@jevellan/core';
import { DeviceRegistry, HubAccounts, HubCheckoutStore, HubDatabase, HubIndexes, HubMesh, HubProjectAccess, HubPublicationLeases, HubState, MemberAccounts, MemberCheckoutStore, MemberHubClient, MemberIndexes, MemberProjectStore, MemberPublicationLeases, MemberState, MemberUiAuth, ProjectImproverHub, UiAuth, memberConnection } from '@jevellan/mesh';
import { AccountService } from '@jevellan/accounts';
import { BackgroundDrafts, ContextOperations, ConversationService, StretchBridges } from '@jevellan/conversations';
import { ProjectWork, type ProjectTimers } from '@jevellan/projects';
import { RoutingImprover } from './routing-improver.js';
import { Improver } from './improver.js';
import { ProjectImprover, type MemoryPort } from './project-improver.js';
import { migrateContextOperations } from './context-migration.js';
import { BasicMemory, HubMemoryStore, ProjectVault, remoteHubMemory, vaultFolder, type VaultRemote } from '@jevellan/memory';
import { ProjectMemoryRequestSchema, type ProjectMemoryRequest } from '@jevellan/core';
import { memoryImportBatches } from '@jevellan/memory';
import { DEFAULT_DECISION_TIMEOUT_MS, JevClient, JevError, decisionDeadlineMs } from '@jevellan/decisions';
import { createRuntime as createClaude } from '@jevellan/runtime-claude';
import { createRuntime as createCodex, prepareApiKey } from '@jevellan/runtime-codex';
import type { RuntimeAdapter, RuntimeContext } from '@jevellan/runtime-contract';
import { materialiseConfiguration, type SharedRigging } from '@jevellan/core';
import { CursorSessions, DevicePresence, ExternalSessionSensor, type SessionSensorOptions } from '@jevellan/mesh';
import { SettingsSync } from './settings-sync.js';
import { LifecycleGate } from '@jevellan/core';
import { AgentAccess, HubAgentAccess } from '@jevellan/mesh';
import { assertHubNotMoved, deviceAllowsWork } from '@jevellan/core';
import { TerminalService } from './terminal-service.js';

export type ApplicationOptions = { pushSend?: PushSend; homes?: Homes; port?: number; url?: string; runtimes?: (context: RuntimeContext) => ReadonlyMap<string, RuntimeAdapter>; timers?: boolean; repositoryVisibility?: VisibilityProbe; decisionFetch?: typeof fetch; hubFetch?: typeof fetch; nativeSessions?: Omit<SessionSensorOptions, 'homes'>; deviceFacts?(): DeviceFacts;
  /** Test seam for the improver's memory index; production uses the isolated Basic Memory. */ projectMemory?: (project: Project) => MemoryPort;
  /** Projects test seams: the GitHub transport and API base (a fake server in tests), and Projects timers (periodic loops follow `timers`). */
  githubFetch?: typeof fetch; githubBaseUrl?: string; projectTimers?: Partial<ProjectTimers>; ekoaConnector?: EkoaConnector; forceHub?: boolean;
  /** Test seam: the version this device reports and compares with its hub's (B5). */ version?: string;
  /** Test seam: the vault remote (phase 5). Without it, a fake GitHub (`githubBaseUrl`) keeps the vault local. */ vaultRemote?: () => Promise<VaultRemote | null>;
  terminalOptions?: ConstructorParameters<typeof TerminalService>[1] };

export class Application {
  #closing: Promise<void> | undefined;
  #configurationRevision = 0;
  #decisionTimeoutMs = DEFAULT_DECISION_TIMEOUT_MS;
  #riggingQueue: Promise<unknown> = Promise.resolve();
  readonly #ownership: DaemonOwnership;
  readonly lifecycle: LifecycleGate;
  /** Resolves once startup recovery is complete and the startup lifecycle activity is released. */
  readonly started: Promise<void>;
  readonly #hub: HubDatabase | undefined;
  readonly #mesh: HubMesh | undefined;
  readonly homes: Homes; readonly device: DeviceConfig; readonly redactor: SecretRedactor;
  readonly member: MemberHubClient | undefined;
  readonly version: string;
  readonly agentAccess: AgentAccess;
  readonly hubAgentAccess: HubAgentAccess | undefined;
  readonly accounts: AccountService; readonly auth: UiAuth | MemberUiAuth; readonly rigging: SharedRigging;
  readonly bridges: StretchBridges;
  readonly memory: BasicMemory; readonly conversations: ConversationService;
  readonly hubMemory: HubMemoryStore | undefined;
  /** The hub's working copy of the private vault repository: project memory, definitions and notebooks (phase 5). */
  readonly vault: ProjectVault | undefined;
  /** Projects on this device (brief 8): threads, their turns and pull requests, beside the conversations. */
  readonly ekoa: EkoaMirrorService | undefined;
  readonly library: ProjectLibraryService;
  readonly notifications: HubNotifications | undefined;
  readonly cleanup: CleanupService; readonly projectWork: ProjectWork; readonly projectHub: ProjectHub;
  /** The owner tools (bridge): only the state point serves them. */
  #ownerTools: OwnerTools | undefined;
  #ownerEvents: OwnerEvents | undefined;
  #ownerPushes: OwnerPushes | undefined;
  #ownerBridges: OwnerBridges | undefined;
  get ownerPushes(): OwnerPushes { if (!this.#ownerPushes) throw Object.assign(new Error('Jevellan tools run on the state point. Use them on the device that holds the hub.'), { status: 409 }); return this.#ownerPushes; }
  get ownerBridges(): OwnerBridges { if (!this.#ownerBridges) throw Object.assign(new Error('The bridge runs on the state point. Start it on the device that holds the hub.'), { status: 409 }); return this.#ownerBridges; }
  get ownerEvents(): OwnerEvents { if (!this.#ownerEvents) throw Object.assign(new Error('Jevellan tools run on the state point. Use them on the device that holds the hub.'), { status: 409 }); return this.#ownerEvents; }
  get ownerTools(): OwnerTools { if (!this.#hub) throw Object.assign(new Error('Jevellan tools run on the state point. Use them on the device that holds the hub.'), { status: 409 }); return this.#ownerTools ??= new OwnerTools(this); }
  readonly terminals: TerminalService;
  readonly projectVisibility: ProjectVisibility;
  readonly state: HubState | MemberState;
  readonly riggingDisk: RiggingDisk;
  readonly decisionClient: (() => Promise<JevClient>) & { deadlineMs(): number };
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
    this.version = options.version ?? VERSION;
    this.#improverTimers = options.timers !== false;
    this.projectVisibility = new ProjectVisibility(options.repositoryVisibility);
    this.homes = options.homes ?? new Homes(); assertHubNotMoved(this.homes, options.forceHub); this.homes.ensure();
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
    this.hubAgentAccess = this.#hub ? new HubAgentAccess(this.#hub) : undefined;
    this.agentAccess = new AgentAccess(this.hubAgentAccess, this.member);
    try {
      const contexts = new ContextOperations(this.homes);
      if (this.#hub) {
        if (!this.#hub.configuration.current()) this.#hub.configuration.put(seedConfiguration(), 0, { deviceId: this.device.deviceId, source: 'install' });
        this.#hub.configuration.materialise(this.homes);
        const localDevice = this.#hub.get('devices', this.device.deviceId, DeviceSchema);
        if (!localDevice) this.#hub.put('devices', this.device.deviceId, DeviceSchema, { schema: 'device-v1', id: this.device.deviceId, name: this.device.name, role: 'hub', url: this.device.url, os: process.platform, version: this.version, joinedAt: new Date().toISOString() }, 0);
        else if (localDevice.document.url !== this.device.url || localDevice.document.version !== this.version) this.#hub.put('devices', this.device.deviceId, DeviceSchema, { ...localDevice.document, url: this.device.url, version: this.version }, localDevice.revision);
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
      this.runtimes = deviceAllowsWork(this.homes) ? options.runtimes?.(context) ?? new Map([['claude', createClaude(context)], ['codex', createCodex(context)]]) : new Map();
      this.state = this.member ? new MemberState(this.member, [...this.runtimes.keys()]) : new HubState(this.hub, this.device.deviceId, [...this.runtimes.keys()]); this.rigging = this.state.rigging;
      this.riggingDisk = new RiggingDisk(this.homes, this.redactor);
      this.bridges = new StretchBridges(this.redactor);
      this.memory = new BasicMemory(this.homes, 'basic-memory', this.redactor);
      this.vault = this.member ? undefined : new ProjectVault({ homes: this.homes, deviceId: this.device.deviceId, redactor: this.redactor, now: Date.now, timers: options.timers !== false,
        remote: options.vaultRemote ?? (() => this.#vaultRemote(options)) });
      this.hubMemory = this.member ? undefined : new HubMemoryStore(this.memory, this.device.deviceId, Date.now, { vault: this.vault!,
        folder: projectId => vaultFolder(this.hub.get('projects', projectId, ProjectSchema)?.document.remoteUrl) });
      this.memory.configureHub((project, _deviceId, scope) => {
        const context = scope ?? { kind: 'viewer' as const };
        return this.member ? remoteHubMemory(this.homes, project, context, request => this.member!.projectMemory(request)) : this.hubMemory!.project(project, context);
      }, async (project, old) => {
        if (!this.member) { await this.hubMemory!.import(project, old); return; }
        const sourcePath = this.memory.project(old, this.device.deviceId, () => {}).path;
        for (const files of memoryImportBatches(sourcePath, text => this.redactor.text(text))) await this.member.projectMemory({ schema: 'project-memory-request-v1', projectId: project.id,
          scope: { kind: 'viewer' }, operation: 'import', requestId: 'initial_memory_import', sourcePath, files, final: false });
        await this.member.projectMemory({ schema: 'project-memory-request-v1', projectId: project.id, scope: { kind: 'viewer' }, operation: 'import', requestId: 'initial_memory_import', sourcePath, files: [], final: true });
      });
      this.sessions = new ExternalSessionSensor({ ...options.nativeSessions, homes: this.homes });
      this.cursor = new CursorSessions(this.homes, this.device.deviceId, this.device.name);
      this.accounts = new AccountService({ store: this.member ? new MemberAccounts(this.member) : new HubAccounts(this.hub, this.device.deviceId), redactor: this.redactor, homes: this.homes, deviceId: this.device.deviceId, runtimes: this.runtimes,
        configurationChanged: async () => { await this.configuration(); },
        ...(!options.runtimes ? { prepare: async (account) => { if (account.account.runtime === 'codex' && account.account.kind === 'api-key') await prepareApiKey(account, context); } } : {}),
        ...(options.timers === undefined ? {} : { timers: options.timers }),
      });
      // Decisions read the configuration (the per-attempt timeout) and the key when they ask; the overall deadline uses the last timeout
      // read, so a configuration read that never settles is bounded too (fix-051).
      this.decisionClient = Object.assign(async () => new JevClient({ key: () => this.state.jev.credential(), timeoutMs: (await this.configuration()).configuration['x-jevellan'].decisions.timeoutMs, ...(options.decisionFetch ? { fetch: options.decisionFetch } : {}) }),
        { deadlineMs: () => decisionDeadlineMs(this.#decisionTimeoutMs) });
      const accountRuns = new Set<string>();
      const leases = this.member ? new MemberPublicationLeases(this.member) : new HubPublicationLeases(this.hub, this.device.deviceId);
      this.conversations = new ConversationService({ homes: this.homes, contexts, projects: this.state.projects, deviceId: this.device.deviceId, accounts: this.accounts, runtimes: this.runtimes,
        coordination: this.member ? new MemberCheckoutStore(this.member) : new HubCheckoutStore(this.hub, this.device.deviceId), leases, indexes: this.member ? new MemberIndexes(this.member) : new HubIndexes(this.hub, this.device.deviceId),
        bridges: this.bridges, memory: this.memory, redactor: this.redactor, settings: async () => (await this.configuration()).configuration['x-jevellan'], riggingItems: (runtime, projectId) => this.rigging.items(runtime, projectId),
        deviceLabel: this.device.name, jevAvailable: async () => (await this.state.jev.summary()).saved, externalSessions: (projects, deviceId) => this.sessions.read(projects, deviceId),
        decisionClient: this.decisionClient, accountRuns, enterOperation: (id, title) => this.lifecycle.enter({ kind: 'conversation', id, title }) });
      this.backgroundDrafts = new BackgroundDrafts({ homes: this.homes, deviceId: this.device.deviceId, accounts: this.accounts, runtimes: this.runtimes, bridges: this.bridges,
        redactor: this.redactor, settings: async () => (await this.configuration()).configuration['x-jevellan'], riggingItems: (runtime, projectId) => this.rigging.items(runtime, projectId),
        accountRuns, enterOperation: (id, title) => this.lifecycle.enter({ kind: 'settings', id, title }) });
      // Projects share the account serialization, checkout ownership, leases, bridge registry and memory with conversations.
      this.projectHub = this.member ? new MemberProjectStore(this.member) : new HubProjectAccess(this.hub, this.device.deviceId, undefined, () => this.devices.list());
      this.library = new ProjectLibraryService(this);
      this.projectWork = new ProjectWork({ deployHealth: async (id, checks, trigger, deployId) => { const runs: ProjectHealthRun[] = []; for (const definition of checks) { const view = await this.projectHealthRequest({ schema: 'project-health-request-v1', project: id, operation: 'run', trigger, deployId, definition }); runs.push(...view.runs); } return runs; }, library: this.library, homes: this.homes, deviceId: this.device.deviceId, deviceName: this.device.name, redactor: this.redactor, workRefusal: () => this.versionRefusal(),
        journal: { isHub: !this.member, ...(this.member ? { request: input => this.member!.projectJournal(input) } : {}) },
        terminalRead: (scope, input) => this.terminals.read(scope.kind === 'thread' ? { kind: 'thread', projectId: scope.projectId, threadId: scope.threadId }
          : { kind: 'coordinator', projectId: scope.projectId }, input),
        switchMemory: async (projectId, mode, requestId) => {
          const current = await this.state.projects.get(projectId); if (!current) throw new Error('Project not found.');
          return (await this.conversations.saveProject({ schema: 'project-write-v1', revision: current.revision, clientRequestId: `memory_${requestId}`, project: { ...current.project, memory: { ...current.project.memory, mode } } })).project;
        },
        ...(this.hubMemory ? { hubMemory: this.hubMemory } : {}),
        sendCapture: async request => { if (this.member) await this.member.projectMemory(request); else if (request.operation === 'capture') this.projectWork.captures.accept(request.capture, request.text); },
        ...(options.deviceFacts ? { facts: options.deviceFacts } : {}),
        projects: this.state.projects, hub: this.projectHub, environment: { credentials: async projectId => this.state.environment.credentials(projectId) },
        github: { credential: async (projectId) => this.state.github.credential(projectId), ...(options.githubFetch ? { fetch: options.githubFetch } : {}), ...(options.githubBaseUrl ? { baseUrl: options.githubBaseUrl } : {}) },
        accounts: this.accounts, runtimes: this.runtimes, accountRuns, ownership: this.conversations.ownership, leases: this.conversations.leases,
        outside: { assertIdle: async (project, path) => this.conversations.outside.assertIdle(project, path, (await this.configuration()).configuration['x-jevellan'].guards.externalActivityWindowMin) },
        bridges: this.bridges, memory: this.memory, settings: async () => (await this.configuration()).configuration['x-jevellan'], riggingItems: async (runtime, projectId) => this.rigging.items(runtime, projectId),
        decisionClient: this.decisionClient, roster: () => this.roster(),
        enterOperation: (id, title) => this.lifecycle.enter({ kind: 'conversation', id, title }),
        timers: { periodic: options.timers !== false, ...options.projectTimers } });
      this.cleanup = new CleanupService({ homes: this.homes, deviceId: this.device.deviceId,
        settings: async () => (await this.configuration()).configuration['x-jevellan'].cleanup, inventory: () => this.projectWork.cleanupInventory.items(),
        protectedPaths: async () => (await this.roster()).devices.find(row => row.device.id === this.device.deviceId)?.device.protectedPaths ?? [],
        maintenance: () => this.projectWork.jobs.busy() ? null : this.lifecycle.tryMaintenance(), ...(options.deviceFacts ? { freeBytes: () => options.deviceFacts!().freeDiskBytes } : {}) });
      this.terminals = new TerminalService(this, { ...options.terminalOptions, timers: options.timers !== false });
      this.notifications = this.#hub ? new HubNotifications(this.hub, () => this.device.url, options.pushSend) : undefined;
      this.ekoa = this.#hub ? new EkoaMirrorService(this.hub, () => this.device.url, options.ekoaConnector) : undefined;
      // The owner event stream listens from the start so watch and pushes see everything after start-up (bridge).
      if (this.#hub) { this.#ownerEvents = new OwnerEvents(this); this.#ownerPushes = new OwnerPushes(this); this.#ownerBridges = new OwnerBridges(this); }
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
      this.presence = new DevicePresence({ cleanup: () => { const run = this.cleanup.state().lastRun; return run ? { schema: 'cleanup-summary-v1', endedAt: run.endedAt, freedBytes: run.freedBytes, removed: run.removed, protected: run.protected, freeBytes: run.freeBytes, state: run.state, ...(run.reason ? { reason: run.reason } : {}) } : null; }, deviceId: this.device.deviceId, version: this.version, sensor: this.sessions,
        facts: () => options.deviceFacts?.() ?? collectDeviceFacts(this.homes, this.projectWork.runningThreads(), this.projectWork.jobs.runningIds()),
        workPolicy: () => ({ schema: 'device-work-policy-v1', mode: deviceAllowsWork(this.homes) ? 'work' : 'apps-only' }),
        projects: async () => (await this.state.projects.list()).map(row => row.project), running: () => this.conversations.localRunning(),
        report: async heartbeat => {
          await this.conversations.checkExternalActivity();
          const result = await (this.member ? this.member.heartbeat(heartbeat) : this.devices.heartbeat(this.device.deviceId, heartbeat));
          this.conversations.hubWaits.reachable(); return result;
        }, ready: this.conversations.ready,
        ...(options.timers === undefined ? {} : { timers: options.timers }) });
      this.settingsSync = new SettingsSync({ homes: this.homes, redactor: this.redactor, ready: this.conversations.ready, apply: () => this.applyRigging(), ...(options.timers === undefined ? {} : { timers: options.timers }) });
      const releaseStartup = startup; startup = undefined;
      // Startup ends after conversation recovery and Projects recovery (brief 8.6); the improvers still wait only for theirs.
      this.started = Promise.all([improverReady, this.projectWork.ready]).then(releaseStartup, releaseStartup).catch(() => undefined);
      // Phase 5: bring in what another hub pushed, then push anything left from the last run.
      void this.started.then(() => this.vault?.sync()).catch(() => undefined);
    } catch (error) { this.#hub?.close(); throw error; }
    } catch (error) { startup?.(); lifecycle?.close(); this.#ownership.close(); throw error; }
  }
  /** B5: a member newer than its hub starts no new work, since the older hub may refuse its requests. */
  versionRefusal(): string | undefined {
    const hub = this.member?.hubVersion;
    return hub && compareVersions(this.version, hub) > 0 ? versionSkewMessage(this.version, hub) : undefined;
  }
  vaultView(): VaultView {
    if (!this.vault) throw Object.assign(new Error('The vault belongs to the hub.'), { status: 404 });
    const { schema: _schema, ...status } = this.vault.status(); void _schema;
    return VaultViewSchema.parse({ schema: 'vault-view-v1', ...status, folders: this.vault.folders() });
  }
  /**
   * Phase 5.6: a project added on this hub takes its definition from the vault. This device becomes its only allowed device (device ids
   * never travel through the vault); work settings, goals, jobs, dailies and the notebook follow by name, so a repeat changes nothing.
   */
  async restoreProjectFromVault(projectId: string): Promise<{ schema: 'vault-restore-v1'; projectId: string; restored: boolean }> {
    if (!this.vault) throw Object.assign(new Error('The vault belongs to the hub.'), { status: 404 });
    await this.conversations.ready;
    const row = (await this.conversations.projects()).projects.find(entry => entry.project.id === projectId);
    if (!row) throw Object.assign(new Error('Project not found.'), { status: 404 });
    const folder = vaultFolder(row.project.remoteUrl); if (!folder) throw Object.assign(new Error('Only a project with a GitHub origin has a vault folder.'), { status: 409 });
    await this.vault.pull();
    const text = this.vault.read(folder, 'project.json'); if (!text) return { schema: 'vault-restore-v1', projectId, restored: false };
    const definition = VaultProjectSchema.parse(JSON.parse(text));
    const project = { ...row.project, allowedDevices: [this.device.deviceId], branchPolicy: definition.gitPolicy, ...(!row.project.testCommand && definition.testCommand ? { testCommand: definition.testCommand } : {}) };
    if (stableJson(project) !== stableJson(row.project)) await this.conversations.saveProject({ schema: 'project-write-v1', revision: row.revision, clientRequestId: `vault_restore_${row.revision}`, project });
    await this.projectWork.restoreFromVault(projectId);
    return { schema: 'vault-restore-v1', projectId, restored: true };
  }
  #vaultLogin: { token: string; login: string } | undefined;
  /** The owner's `jevellan-vault` repository, named by the account of the shared GitHub token, or `JEVELLAN_VAULT_REMOTE` (owner/repo). */
  async #vaultRemote(options: ApplicationOptions): Promise<VaultRemote | null> {
    const token = await this.state.github.credential(); if (!token || options.githubBaseUrl) return null;
    const configured = process.env.JEVELLAN_VAULT_REMOTE?.trim();
    if (configured) return { url: `https://github.com/${configured}.git`, token };
    if (this.#vaultLogin?.token !== token) {
      const client = new GitHubClient({ token: async () => token, redactor: this.redactor, ...(options.githubFetch ? { fetch: options.githubFetch } : {}), ...(options.githubBaseUrl ? { baseUrl: options.githubBaseUrl } : {}) });
      this.#vaultLogin = { token, login: await client.viewer() };
    }
    return { url: `https://github.com/${this.#vaultLogin.login}/jevellan-vault.git`, token };
  }
  bindDaemonUrl(url: string): void {
    this.conversations.daemonUrl = url; this.backgroundDrafts.daemonUrl = url;
    // Thread turns need the bridge URL; queued work may start from here. Its periodic loops follow `timers` on their own.
    if (this.#improverTimers) { this.ekoa?.start(); this.notifications?.start(); this.cleanup.start(); this.#ownerPushes?.start(); this.#ownerBridges?.start(); }
    this.projectWork.daemonUrl = url; this.projectWork.start();
    if (this.#improverTimers) { this.routingImprover?.start(); this.projectImprover.start(); }
  }
  async notificationsRequest(raw: unknown, ownerSession: string) { const input = NotificationOwnerRequestSchema.parse({ ...(raw as object), ownerSession }); return this.member ? this.member.notifications(input) : this.notifications!.request(input); }
  async ekoaRequest(raw: unknown, ownerSession: string) {
    const request = EkoaRequestSchema.parse({ ...(raw as object), ownerSession });
    return this.member ? this.member.ekoa(request) : this.ekoa!.request(request, this.device.deviceId);
  }
  /** Health checks always execute at the state point, including local commands issued on a member. */
  async projectHealthRequest(raw: ProjectHealthRequest) {
    const input = ProjectHealthRequestSchema.parse(raw);
    if (this.member) return this.member.projectHealth(input);
    const projects = (await this.state.projects.list()).map(row => row.project);
    const matches = projects.filter(project => project.id === input.project || project.name === input.project);
    if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'More than one project has that name. Use its id.' : 'Project not found.'), { status: matches.length ? 409 : 404 });
    const projectId = matches[0]!.id;
    if (input.operation === 'list') return ProjectHealthViewSchema.parse({ schema: 'project-health-view-v1', projectId,
      runs: this.hub.listByField('project-health', 'projectId', projectId, ProjectHealthRunSchema).map(row => row.document).sort((a, b) => b.at.localeCompare(a.at)) });
    return ProjectHealthViewSchema.parse({ schema: 'project-health-view-v1', projectId, runs: await this.runProjectHealth(projectId, input.trigger ?? 'manual', input.deployId, input) });
  }
  async runProjectHealth(projectId: string, trigger: ProjectHealthRun['trigger'], deployId?: string, input?: Pick<ProjectHealthRequest, 'check' | 'definition'>): Promise<ProjectHealthRun[]> {
    if (this.member) throw new Error('Health checks run at the state point.');
    const checks = input?.definition ? [input.definition] : (await this.projectWork.settingsView(projectId)).settings.healthChecks.filter(check => check.enabled && (!input?.check || check.id === input.check || check.name === input.check));
    if (input?.check && !checks.length) throw Object.assign(new Error('Health check not found.'), { status: 404 });
    const runs: ProjectHealthRun[] = [];
    for (const check of checks) {
      const run = await runHealthCheck(projectId, check, trigger, deployId);
      this.hub.transaction(() => {
        this.hub.put('project-health', run.id, ProjectHealthRunSchema, run, 0);
        const old = this.hub.listByField('project-health', 'checkId', check.id, ProjectHealthRunSchema).map(row => row.document).filter(row => row.projectId === projectId).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
        for (const row of old.slice(500)) this.hub.delete('project-health', row.id);
      });
      runs.push(run);
    }
    return runs;
  }
  async projectMemoryRequest(raw: unknown, deviceId: string) {
    const request = ProjectMemoryRequestSchema.parse(raw), project = (await this.state.projects.get(request.projectId))?.project;
    if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 });
    if (!this.hubMemory) throw Object.assign(new Error('Project memory belongs to the hub.'), { status: 404 });
    const scope = request.scope;
    if (scope.kind === 'owner' && (!request.ownerSession || !(this.auth instanceof UiAuth) || !this.auth.verify(request.ownerSession, deviceId))) throw Object.assign(new Error('Owner note edits use the owner API.'), { status: 403 });
    if (scope.kind === 'thread') {
      const thread = scope.id ? (await this.projectHub.thread(scope.id))?.document : null;
      if (!thread || thread.projectId !== project.id || thread.ownerDeviceId !== deviceId) throw Object.assign(new Error('This memory scope belongs to another thread.'), { status: 403 });
    }
    if (scope.kind === 'coordinator' && (await this.projectHub.coordinator(project.id))?.document.deviceId !== deviceId) throw Object.assign(new Error('This memory scope belongs to another coordinator.'), { status: 403 });
    if (scope.stagingId) throw Object.assign(new Error('This memory staging session is unavailable.'), { status: 403 });
    if (request.operation === 'import') {
      await this.hubMemory.importBatch({ ...project, memory: { ...project.memory, mode: 'hub' } }, request);
      return { schema: 'memory-operation-v1' as const, accepted: true as const };
    }
    if (['dream-run', 'dream-apply', 'dream-undo', 'dream-discard'].includes(request.operation)) {
      if (scope.kind !== 'owner') throw Object.assign(new Error('Only the owner runs or applies a dream.'), { status: 403 });
      const programme = this.projectWork.memoryProgramme; if (!programme || project.memory.mode !== 'hub') throw new Error('This project does not use hub memory.');
      if (request.operation === 'dream-run') { programme.runNow(project, request.requestId ?? newId('dream_request')); return { schema: 'memory-operation-v1' as const, accepted: true as const }; }
      if (request.operation === 'dream-apply') return programme.applyDream(project);
      if (request.operation === 'dream-undo') return programme.dream.undo(project);
      programme.dream.discard(project.id); return { schema: 'memory-operation-v1' as const, accepted: true as const };
    }
    if (request.operation === 'capture') {
      if (request.capture.projectId !== project.id || request.capture.threadId !== (scope.kind === 'thread' ? scope.id : undefined)) throw Object.assign(new Error('The capture does not belong to this session scope.'), { status: 403 });
      if ((await this.projectWork.admission.settings(project.id)).memory.capture) this.projectWork.captures.accept(request.capture, request.text);
      return { schema: 'memory-operation-v1' as const, accepted: true as const };
    }
    const result = await this.hubMemory.request(project, request as ProjectMemoryRequest, AbortSignal.timeout(120_000));
    return result.schema === 'project-memory-view-v1' ? { ...result, notice: this.projectWork.memoryProgramme?.line(project.id) ?? null } : result;
  }
  async ownerProjectMemory(raw: unknown, ownerSession: string) {
    const request = ProjectMemoryRequestSchema.parse({ ...(raw as object), ownerSession, scope: { kind: 'owner', provenance: { source: 'owner', runtime: 'owner', model: 'owner' } } });
    return this.member ? this.member.projectMemory(request) : this.projectMemoryRequest(request, this.device.deviceId);
  }
  async improverRequest(input: unknown) { return this.member ? this.member.improver(input) : this.routingImprover!.request(input, this.device.deviceId); }
  async configuration() {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#closing) throw Object.assign(new Error('Jevellan is stopping.'), { status: 503 });
      const revision = await this.state.configuration.current();
      if (this.#closing) throw Object.assign(new Error('Jevellan is stopping.'), { status: 503 });
      if (revision.revision < this.#configurationRevision) continue;
      const materialised = materialiseConfiguration(this.homes, revision); this.#configurationRevision = revision.revision;
      this.#decisionTimeoutMs = materialised.configuration['x-jevellan'].decisions.timeoutMs; return materialised;
    }
    throw Object.assign(new Error('Settings changed while loading. Reload the latest version.'), { status: 409 });
  }
  async roster() { return this.member ? this.member.devices() : this.mesh.roster(this.device.deviceId); }
  async updateDeviceTags(input: unknown, ownerSession: string) {
    const value = DeviceTagsInputSchema.parse(input);
    return this.member ? this.member.updateDeviceTags({ schema: 'device-tags-request-v1', input: value, ownerSession }) : this.devices.updateTags(value);
  }
  async updateDeviceSettings(input: unknown, ownerSession: string) {
    const value = DeviceSettingsInputSchema.parse(input);
    return this.member ? this.member.updateDeviceSettings({ schema: 'device-settings-request-v1', input: value, ownerSession }) : this.devices.updateSettings(value);
  }
  async inviteDevice() { return this.member ? this.member.invite() : this.mesh.invite(); }
  async switchDevice(input: unknown) { return this.member ? this.member.issueSwitch(input) : this.devices.issueSwitch(this.device.deviceId, DeviceSwitchInputSchema.parse(input)); }
  async consumeSwitch(input: unknown) { return this.auth instanceof MemberUiAuth ? this.auth.consumeSwitch(input) : this.mesh.consumeSwitch(this.device.deviceId, ConsumeSwitchSchema.parse(input).token); }
  async streamAuthenticated(token: string | undefined) { return this.auth instanceof MemberUiAuth ? this.auth.verifyStream(token) : !!this.auth.verify(token); }
  async peerAuthenticated(input: unknown, existingStream = false) { return this.auth instanceof MemberUiAuth ? this.auth.verifyPeer(input, existingStream) : !!this.mesh.peerSession(this.device.deviceId, input).session; }
  async peerLoginAuthenticated(input: unknown, existingStream = false) { return this.auth instanceof MemberUiAuth ? this.auth.verifyPeerLogin(input, existingStream) : !!this.mesh.peerLoginSession(this.device.deviceId, input).session; }
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
    try { await this.cleanup.close(); } catch (error) { failures.push(error); }
    try { await this.settingsSync.close(); await this.#riggingQueue.catch(() => undefined); } catch (error) { failures.push(error); }
    try { this.#ownerPushes?.close(); this.#ownerBridges?.close(); } catch (error) { failures.push(error); }
    try { await this.notifications?.close(); } catch (error) { failures.push(error); }
    try { await this.ekoa?.close(); } catch (error) { failures.push(error); }
    try { await this.presence.close(); } catch (error) { failures.push(error); }
    try { await this.projectImprover.close(); } catch (error) { failures.push(error); }
    try { await this.routingImprover?.close(); } catch (error) { failures.push(error); }
    try { await this.backgroundDrafts.close(); } catch (error) { failures.push(error); }
    // Projects close first: they share ownership, leases, accounts, bridges, memory and the hub with conversations.
    try { await this.terminals.close(); } catch (error) { failures.push(error); }
    try { await this.projectWork.close(); } catch (error) { failures.push(error); }
    try { await this.vault?.close(); } catch (error) { failures.push(error); }
    try { await this.conversations.close(); } catch (error) { failures.push(error); }
    const cleanup = await Promise.allSettled([this.accounts.close(), this.bridges.close(), this.memory.close()]);
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason);
    try { this.#hub?.close(); } catch (error) { failures.push(error); }
    // Requests admitted before the listeners closed (their clients are gone) finish first; work that stays stuck still fails the close.
    try { await this.lifecycle.idle(5_000); this.lifecycle.close(); } catch (error) { failures.push(error); }
    try { this.#ownership.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Application cleanup did not complete.');
  })(); }
}

export { RiggingApplicationSchema } from '@jevellan/core';
