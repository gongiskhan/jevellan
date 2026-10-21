import { CleanupSettingsSaveSchema, normalizeCleanupSettings } from '@jevellan/core';
import { GlobalThreadLimitSaveSchema, normalizeGlobalThreadLimit } from '@jevellan/core';
import { RuntimeSettingsSaveSchema, normalizeRuntimeSettings, stableJson } from '@jevellan/core';
import {
  ProjectEnvNameSchema, StoredProjectWorkSettingsSchema, ProjectEnvSecretSummarySchema, CheckoutClaimSchema, ConfigWriteSchema, ConversationIndexSchema, CredentialInputSchema, GitHubTokenStateSchema, IdSchema, ProjectSchema, ProjectViewSchema, RiggingEntrySchema, RiggingStore, SecretSummarySchema, SharedStateRequestSchema, SharedStateResultSchema, ThreadIndexSchema, isTerminal,
  type SharedProjectEnvironment, type GitHubTokenState, type Project, type SharedConfiguration, type SharedGitHub, type SharedJev, type SharedProjects, type SharedRigging,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { HubProtocolError, type MemberHubClient } from './client.js';
import { HubRigging } from './rigging.js';
import { settingsMutation } from './settings-mutation.js';
import { createHash } from 'node:crypto';
import { DeviceSchema, parseGitHubRemote } from '@jevellan/core';
import { ConfigRevisionSchema, SecretStateSchema, OfferedModelsSchema, DecisionsSettingsPreviewSchema, DecisionsSettingsSaveSchema, JevCheckRecordSchema, JevKeyGenerationSchema,
  decisionsSettingsEditor, normalizeDecisionsSettings, jevConnectionView, type ConfigRevision } from '@jevellan/core';

export class HubState {
  readonly configuration: SharedConfiguration;
  readonly projects: SharedProjects;
  readonly jev: SharedJev;
  readonly github: SharedGitHub;
  readonly environment: SharedProjectEnvironment;
  readonly rigging: RiggingStore;
  constructor(readonly hub: HubDatabase, readonly deviceId: string, runtimes: readonly string[]) {
    IdSchema.parse(deviceId); this.rigging = new HubRigging(hub, deviceId, runtimes);
    const clean = (value: unknown) => { if (hub.redactor.text(JSON.stringify(value)) !== JSON.stringify(value)) throw new Error('Store credentials in their Settings fields.'); };
    const current = (): ConfigRevision => { const value = hub.configuration.current(); if (!value) throw new Error('Configuration has not been initialized.'); return value; };
    const generation = () => hub.get('jev-key-generation', 'current', JevKeyGenerationSchema)?.document.generation ?? 0;
    const checked = () => { const row = hub.get('jev-settings-check', 'current', JevCheckRecordSchema)?.document; return row?.generation === generation() ? row.result : null; };
    const offers = () => hub.list('offered-models', OfferedModelsSchema).map(row => row.document);
    const jevSummary = () => SecretStateSchema.parse(hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('jev') ? hub.vault.summary('jev') : { schema: 'secret-state-v1', id: 'jev', saved: false });
    const projectView = (row: { revision: number; document: Project }) => ProjectViewSchema.parse({ schema: 'project-view-v1', revision: row.revision, project: row.document });
    this.configuration = {
      current,
      history: () => hub.configuration.history(),
      put: raw => { const input = ConfigWriteSchema.parse(raw); clean(input.configuration); return hub.configuration.put(input.configuration, input.revision, { deviceId, source: 'ui' }, undefined, input.clientRequestId); },
      decisionsEditor: raw => {
        const input = raw === undefined ? undefined : DecisionsSettingsPreviewSchema.parse(raw), latest = current(), base = input ? hub.configuration.revision(input.revision) : latest;
        if (!base) throw Object.assign(new Error('The configuration revision is unavailable. Reload decisions settings.'), { status: 409 });
        return decisionsSettingsEditor(base, latest.revision, offers(), checked(), input);
      },
      cleanupPut: raw => {
        const input = CleanupSettingsSaveSchema.parse(raw); clean(input);
        return settingsMutation(hub, deviceId, 'cleanup-put', input, input.clientRequestId, ConfigRevisionSchema, () => {
          const latest = current(); if (input.revision !== latest.revision) throw Object.assign(new Error('Settings changed elsewhere. Reload cleanup settings before saving.'), { status: 409 });
          const configuration = normalizeCleanupSettings(latest, input);
          return stableJson(configuration) === stableJson(latest.configuration) ? latest : hub.configuration.put(configuration, latest.revision, { deviceId, source: 'ui' });
        });
      },
      limitsPut: raw => {
        const input = GlobalThreadLimitSaveSchema.parse(raw); clean(input);
        return settingsMutation(hub, deviceId, 'limits-put', input, input.clientRequestId, ConfigRevisionSchema, () => {
          const latest = current(); if (input.revision !== latest.revision) throw Object.assign(new Error('Settings changed elsewhere. Reload the thread limit before saving.'), { status: 409 });
          const configuration = normalizeGlobalThreadLimit(latest, input);
          return stableJson(configuration) === stableJson(latest.configuration) ? latest : hub.configuration.put(configuration, latest.revision, { deviceId, source: 'ui' });
        });
      },
      runtimesPut: raw => {
        const input = RuntimeSettingsSaveSchema.parse(raw); clean(input);
        return settingsMutation(hub, deviceId, 'runtimes-put', input, input.clientRequestId, ConfigRevisionSchema, () => {
          const latest = current(); if (input.revision !== latest.revision) throw Object.assign(new Error('Settings changed elsewhere. Reload runtime settings before saving.'), { status: 409 });
          const configuration = normalizeRuntimeSettings(latest, input);
          return stableJson(configuration) === stableJson(latest.configuration) ? latest : hub.configuration.put(configuration, latest.revision, { deviceId, source: 'ui' });
        });
      },
      decisionsPut: raw => {
        const input = DecisionsSettingsSaveSchema.parse(raw); clean(input);
        return settingsMutation(hub, deviceId, 'decisions-put', input, input.clientRequestId, ConfigRevisionSchema, () => {
          const latest = current(); if (input.revision !== latest.revision) throw Object.assign(new Error('Settings changed elsewhere. Your draft is preserved. Reload the latest decisions settings before saving.'), { status: 409 });
          const result = normalizeDecisionsSettings(latest, input.fields, offers(), checked(), input.draftRequestId);
          if (!result.configuration) throw Object.assign(new Error(result.validation.map(issue => issue.message).join(' ')), { status: 400 });
          return hub.configuration.put(result.configuration, input.revision, { deviceId, source: 'ui' });
        });
      },
    };
    this.projects = {
      get: id => { const row = hub.get('projects', IdSchema.parse(id), ProjectSchema); return row ? projectView(row) : null; },
      list: () => hub.list('projects', ProjectSchema).map(projectView),
      put: (raw, revision, clientRequestId) => {
        const project = ProjectSchema.parse(raw); clean(project);
        const repository = parseGitHubRemote(project.remoteUrl ?? '');
        if (repository?.owner === 'gongiskhan' && repository.repo === 'ekoa-code' && project.allowedDevices?.some(id => hub.get('devices', id, DeviceSchema)?.document.workPolicy?.mode === 'apps-only'))
          throw Object.assign(new Error('Ekoa Code cannot run on an apps-only device.'), { status: 409 });
        return settingsMutation(hub, deviceId, 'project-put', { project, revision }, clientRequestId, ProjectViewSchema, () => {
          const previous = hub.get('projects', project.id, ProjectSchema)?.document;
          if (previous && hub.list('checkout-ownership', CheckoutClaimSchema).some(({ document: claim }) => claim.held && (previous.paths[claim.deviceId] === claim.path || hub.get('conversations', claim.conversationId, ConversationIndexSchema)?.document.projectId === project.id))) throw Object.assign(new Error('This project is in use. Finish its open work before changing its settings.'), { status: 409 });
          // D92: worktree threads hold no checkout claim, so paths and Git policy stay fixed while any thread is open.
          // D924: adding a path for a device that has none leaves every existing path in place, so it stays allowed.
          const pathsChanged = previous && Object.entries(previous.paths).some(([id, path]) => project.paths[id] !== path);
          if (previous && (pathsChanged || previous.branchPolicy !== project.branchPolicy) && hub.listByField('project-threads', 'projectId', project.id, ThreadIndexSchema).some(({ document: thread }) => !isTerminal(thread.state))) throw Object.assign(new Error('This project has open threads. Stop or finish them before changing its path or Git policy.'), { status: 409 });
          if (repository?.owner === 'gongiskhan' && repository.repo === 'ekoa-code') {
            for (const row of hub.list('devices', DeviceSchema)) if (row.document.os === 'linux' && project.paths[row.document.id] === '/home/ggomes/jevellan-projects/ekoa-code') {
              const protectedPaths = [...new Set([...(row.document.protectedPaths ?? []), '/home/ggomes/dev/ekoa-code'])];
              if (protectedPaths.length > 20) throw new Error('Keep room for the Ekoa owner checkout in this device\'s 20 protected paths.');
              if (protectedPaths.length !== row.document.protectedPaths?.length) hub.put('devices', row.document.id, DeviceSchema, { ...row.document, protectedPaths }, row.revision);
            }
          }
          return projectView(hub.put('projects', project.id, ProjectSchema, project, revision));
        });
      },
      context: (id, context, revision) => {
        const current = hub.get('projects', IdSchema.parse(id), ProjectSchema); if (!current) throw Object.assign(new Error('Project not found.'), { status: 404 });
        return projectView(hub.put('projects', id, ProjectSchema, { ...current.document, context: ProjectSchema.shape.context.parse(context) }, revision));
      },
    };
    this.jev = {
      summary: jevSummary,
      put: (raw, clientRequestId) => {
        const value = CredentialInputSchema.parse(raw);
        settingsMutation(hub, deviceId, 'jev-put', { value }, clientRequestId, SecretSummarySchema, () => {
          const result = hub.vault.put('jev', value), previous = hub.get('jev-key-generation', 'current', JevKeyGenerationSchema);
          hub.put('jev-key-generation', 'current', JevKeyGenerationSchema, { schema: 'jev-key-generation-v1', generation: (previous?.document.generation ?? 0) + 1 }, previous?.revision ?? 0);
          return result;
        });
        return hub.vault.summary('jev');
      },
      credential: () => { if (!hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('jev')) return undefined; return hub.vault.forLaunch('jev'); },
      connection: () => jevConnectionView(jevSummary(), checked(), current().configuration['x-jevellan'].decisions.model),
      checkGeneration: generation,
      recordCheck: raw => {
        const input = JevCheckRecordSchema.parse(raw); clean(input.result);
        return hub.transaction(() => {
          if (input.generation !== generation()) throw Object.assign(new Error('The Jev key changed during this check. Test connection again.'), { status: 409 });
          const previous = hub.get('jev-settings-check', 'current', JevCheckRecordSchema);
          hub.put('jev-settings-check', 'current', JevCheckRecordSchema, input, previous?.revision ?? 0); return input.result;
        });
      },
    };
    const environmentKey = (projectId: string, name: string) => {
      if (!hub.get('projects', IdSchema.parse(projectId), ProjectSchema)) throw Object.assign(new Error('Project not found.'), { status: 404 });
      return `project-env/${projectId}/${ProjectEnvNameSchema.parse(name)}`;
    };
    const environmentSummary = (projectId: string, name: string) => {
      const key = environmentKey(projectId, name), saved = !!hub.db.prepare('SELECT id FROM secrets WHERE id=?').get(key);
      return ProjectEnvSecretSummarySchema.parse({ schema: 'project-env-secret-summary-v1', name, saved, ...(saved ? { updatedAt: hub.vault.details(key).updatedAt } : {}) });
    };
    this.environment = {
      summary: environmentSummary,
      copy: async (projectId, name, source) => {
        const value = await (source.kind === 'github' ? this.github.credential(projectId) : source.kind === 'jev' ? this.jev.credential() : hub.vault.forLaunch(environmentKey(projectId, source.name)));
        if (!value) throw Object.assign(new Error('That vault credential is not set.'), { status: 404 });
        return this.environment.put(projectId, name, value);
      },
      put: (projectId, name, value) => { hub.vault.put(environmentKey(projectId, name), CredentialInputSchema.parse(value)); return environmentSummary(projectId, name); },
      remove: (projectId, name) => { hub.vault.remove(environmentKey(projectId, name)); return environmentSummary(projectId, name); },
      credentials: projectId => {
        if (!hub.get('projects', IdSchema.parse(projectId), ProjectSchema)) throw Object.assign(new Error('Project not found.'), { status: 404 });
        const names = hub.get('project-work-settings', projectId, StoredProjectWorkSettingsSchema)?.document.environment.secrets ?? [];
        return Object.fromEntries(names.flatMap(name => { const key = environmentKey(projectId, name); return hub.db.prepare('SELECT id FROM secrets WHERE id=?').get(key) ? [[name, hub.vault.forLaunch(key)]] : []; }));
      },
    };
    const githubKey = (projectId?: string) => {
      if (!projectId) return 'github';
      if (!hub.get('projects', IdSchema.parse(projectId), ProjectSchema)) throw Object.assign(new Error('Project not found.'), { status: 404 });
      return `github_${createHash('sha256').update(projectId).digest('hex').slice(0, 40)}`;
    };
    const github = (projectId?: string): GitHubTokenState => {
      const key = githubKey(projectId);
      return hub.db.prepare('SELECT id FROM secrets WHERE id=?').get(key) ? { schema: 'github-token-summary-v1', id: 'github', saved: true, ...hub.vault.details(key) } : { schema: 'secret-state-v1', id: 'github', saved: false };
    };
    this.github = {
      summary: github,
      put: (raw, clientRequestId, projectId) => {
        const value = CredentialInputSchema.parse(raw);
        const key = githubKey(projectId);
        settingsMutation(hub, deviceId, 'github-put', { value, ...(projectId ? { projectId } : {}) }, clientRequestId, GitHubTokenStateSchema, () => { hub.vault.put(key, value); return github(projectId); });
        return github(projectId);
      },
      remove: (clientRequestId, projectId) => { const key = githubKey(projectId); settingsMutation(hub, deviceId, 'github-remove', projectId ? { projectId } : {}, clientRequestId, GitHubTokenStateSchema, () => { hub.vault.remove(key); return github(projectId); }); return github(projectId); },
      credential: (projectId) => {
        const key = githubKey(projectId);
        if (hub.db.prepare('SELECT id FROM secrets WHERE id=?').get(key)) return hub.vault.forLaunch(key);
        if (projectId && hub.get('projects', projectId, ProjectSchema)?.document.githubTokenScope !== 'project' && hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('github')) return hub.vault.forLaunch('github');
        return undefined;
      },
    };
  }
  async request(raw: unknown) {
    const request = SharedStateRequestSchema.parse(raw); let result: unknown;
    switch (request.operation) {
      case 'project-env-summary': result = { schema: 'shared-project-env-summary-v1', summary: await this.environment.summary(request.projectId, request.name) }; break;
      case 'project-env-copy': result = { schema: 'shared-project-env-summary-v1', summary: await this.environment.copy(request.projectId, request.name, request.source) }; break;
      case 'project-env-put': result = { schema: 'shared-project-env-summary-v1', summary: await this.environment.put(request.projectId, request.name, request.value) }; break;
      case 'project-env-remove': result = { schema: 'shared-project-env-summary-v1', summary: await this.environment.remove(request.projectId, request.name) }; break;
      case 'project-env-credentials': result = { schema: 'shared-project-env-credentials-v1', values: await this.environment.credentials(request.projectId) }; break;
      case 'configuration': result = { schema: 'shared-configuration-v1', revision: await this.configuration.current() }; break;
      case 'configuration-history': result = { schema: 'shared-configuration-history-v1', revisions: await this.configuration.history() }; break;
      case 'configuration-put': result = { schema: 'shared-configuration-v1', revision: await this.configuration.put(request.input) }; break;
      case 'decisions-editor': result = { schema: 'shared-decisions-editor-v1', editor: await this.configuration.decisionsEditor(request.input) }; break;
      case 'runtimes-put': result = { schema: 'shared-configuration-v1', revision: await this.configuration.runtimesPut(request.input) }; break;
      case 'cleanup-put': result = { schema: 'shared-configuration-v1', revision: await this.configuration.cleanupPut(request.input) }; break;
      case 'limits-put': result = { schema: 'shared-configuration-v1', revision: await this.configuration.limitsPut(request.input) }; break;
      case 'decisions-put': result = { schema: 'shared-configuration-v1', revision: await this.configuration.decisionsPut(request.input) }; break;
      case 'jev-connection': result = { schema: 'shared-jev-connection-v1', view: await this.jev.connection() }; break;
      case 'jev-check-generation': result = { schema: 'shared-jev-generation-v1', value: { schema: 'jev-key-generation-v1', generation: await this.jev.checkGeneration() } }; break;
      case 'jev-check-record': result = { schema: 'shared-jev-check-v1', result: await this.jev.recordCheck(request.input) }; break;
      case 'project': result = { schema: 'shared-project-v1', project: await this.projects.get(request.id) }; break;
      case 'projects': result = { schema: 'shared-projects-v1', projects: await this.projects.list() }; break;
      case 'project-put': result = { schema: 'shared-project-v1', project: await this.projects.put(request.project, request.revision, request.clientRequestId) }; break;
      case 'project-context': result = { schema: 'shared-project-v1', project: await this.projects.context(request.id, request.context, request.revision) }; break;
      case 'jev-summary': result = { schema: 'shared-jev-summary-v1', summary: await this.jev.summary() }; break;
      case 'jev-put': result = { schema: 'shared-jev-summary-v1', summary: await this.jev.put(request.value, request.clientRequestId) }; break;
      case 'jev-credential': result = { schema: 'shared-jev-credential-v1', value: await this.jev.credential() ?? null }; break;
      case 'github-summary': result = { schema: 'shared-github-summary-v1', summary: await this.github.summary(request.projectId) }; break;
      case 'github-put': result = { schema: 'shared-github-summary-v1', summary: await this.github.put(request.value, request.clientRequestId, request.projectId) }; break;
      case 'github-remove': result = { schema: 'shared-github-summary-v1', summary: await this.github.remove(request.clientRequestId, request.projectId) }; break;
      case 'github-credential': result = { schema: 'shared-github-credential-v1', value: await this.github.credential(request.projectId) ?? null }; break;
      case 'rigging': result = { schema: 'shared-rigging-v1', items: this.rigging.list() }; break;
      case 'rigging-get': result = { schema: 'shared-rigging-view-v1', item: this.rigging.get(request.id) }; break;
      case 'rigging-add': result = { schema: 'shared-rigging-view-v1', item: this.rigging.add(request.input) }; break;
      case 'rigging-update': result = { schema: 'shared-rigging-view-v1', item: this.rigging.update(request.id, request.input) }; break;
      case 'rigging-validate-captured': result = { schema: 'shared-rigging-entry-v1', item: this.rigging.validateCaptured(request.input) }; break;
      case 'rigging-add-captured': result = { schema: 'shared-rigging-view-v1', item: this.rigging.addCaptured(request.input) }; break;
      case 'rigging-items': result = { schema: 'shared-rigging-items-v1', items: this.rigging.items(request.runtime, request.projectId) }; break;
    }
    return SharedStateResultSchema.parse(result);
  }
}

export class MemberState {
  readonly configuration: SharedConfiguration;
  readonly projects: SharedProjects;
  readonly jev: SharedJev;
  readonly github: SharedGitHub;
  readonly environment: SharedProjectEnvironment;
  readonly rigging: SharedRigging;
  constructor(readonly client: MemberHubClient, readonly runtimes: readonly string[]) {
    const request = async <S extends ReturnType<typeof SharedStateResultSchema.parse>['schema']>(operation: string, schema: S, fields = {}) => {
      const result = await client.state({ schema: 'shared-state-request-v1', operation, ...fields });
      if (result.schema !== schema) throw new HubProtocolError();
      return result as Extract<ReturnType<typeof SharedStateResultSchema.parse>, { schema: S }>;
    };
    const rigging = { runtimes: [...runtimes] };
    this.configuration = {
      current: async () => (await request('configuration', 'shared-configuration-v1')).revision,
      history: async () => (await request('configuration-history', 'shared-configuration-history-v1')).revisions,
      put: async input => (await request('configuration-put', 'shared-configuration-v1', { input })).revision,
      decisionsEditor: async input => (await request('decisions-editor', 'shared-decisions-editor-v1', input === undefined ? {} : { input })).editor,
      runtimesPut: async input => (await request('runtimes-put', 'shared-configuration-v1', { input })).revision,
      cleanupPut: async input => (await request('cleanup-put', 'shared-configuration-v1', { input })).revision,
      limitsPut: async input => (await request('limits-put', 'shared-configuration-v1', { input })).revision,
      decisionsPut: async input => (await request('decisions-put', 'shared-configuration-v1', { input })).revision,
    };
    const writtenProject = async (operation: string, fields: object, id: string, revision: number) => { const result = (await request(operation, 'shared-project-v1', fields)).project; if (!result || result.project.id !== id || result.revision !== revision + 1) throw new HubProtocolError(); return result; };
    this.projects = {
      get: async id => { const result = (await request('project', 'shared-project-v1', { id })).project; if (result && result.project.id !== id) throw new HubProtocolError(); return result; },
      list: async () => (await request('projects', 'shared-projects-v1')).projects,
      put: (project, revision, clientRequestId) => writtenProject('project-put', { project, revision, clientRequestId }, project.id, revision),
      context: (id, context, revision) => writtenProject('project-context', { id, context, revision }, id, revision),
    };
    this.jev = {
      connection: async () => (await request('jev-connection', 'shared-jev-connection-v1')).view,
      checkGeneration: async () => (await request('jev-check-generation', 'shared-jev-generation-v1')).value.generation,
      recordCheck: async input => (await request('jev-check-record', 'shared-jev-check-v1', { input })).result,
      summary: async () => { const summary = (await request('jev-summary', 'shared-jev-summary-v1')).summary; if (summary.id !== 'jev') throw new HubProtocolError(); return summary; },
      put: async (value, clientRequestId) => { const summary = (await request('jev-put', 'shared-jev-summary-v1', { value, clientRequestId })).summary; if (!summary.saved || summary.id !== 'jev') throw new HubProtocolError(); return summary; },
      credential: async () => (await request('jev-credential', 'shared-jev-credential-v1')).value ?? undefined,
    };
    // Saves and removals return the current state, which a later write from another device may already have changed.
    const github = async (operation: string, fields = {}) => { const summary = (await request(operation, 'shared-github-summary-v1', fields)).summary; if (summary.id !== 'github') throw new HubProtocolError(); return summary; };
    this.github = {
      summary: projectId => github('github-summary', { projectId }),
      put: (value, clientRequestId, projectId) => github('github-put', { value, clientRequestId, projectId }),
      remove: (clientRequestId, projectId) => github('github-remove', { clientRequestId, projectId }),
      credential: async projectId => (await request('github-credential', 'shared-github-credential-v1', { projectId })).value ?? undefined,
    };
    const environment = async (operation: string, projectId: string, name: string, value?: string) => {
      const summary = (await request(operation, 'shared-project-env-summary-v1', { projectId, name, ...(value === undefined ? {} : { value }) })).summary;
      if (summary.name !== name) throw new HubProtocolError(); return summary;
    };
    this.environment = {
      copy: async (projectId, name, source) => { const summary = (await request('project-env-copy', 'shared-project-env-summary-v1', { projectId, name, source })).summary; if (summary.name !== name) throw new HubProtocolError(); return summary; },
      summary: (projectId, name) => environment('project-env-summary', projectId, name),
      put: (projectId, name, value) => environment('project-env-put', projectId, name, value),
      remove: (projectId, name) => environment('project-env-remove', projectId, name),
      credentials: async projectId => (await request('project-env-credentials', 'shared-project-env-credentials-v1', { projectId })).values,
    };
    this.rigging = {
      get: async id => { const item = (await request('rigging-get', 'shared-rigging-view-v1', { ...rigging, id })).item; if (item.item.id !== id) throw new HubProtocolError(); return item; },
      list: async () => (await request('rigging', 'shared-rigging-v1', rigging)).items,
      add: async input => (await request('rigging-add', 'shared-rigging-view-v1', { ...rigging, input })).item,
      update: async (id, input) => { const item = (await request('rigging-update', 'shared-rigging-view-v1', { ...rigging, id, input })).item; if (item.item.id !== id) throw new HubProtocolError(); return item; },
      validateCaptured: async input => { const captured = RiggingEntrySchema.parse(input); const item = (await request('rigging-validate-captured', 'shared-rigging-entry-v1', { ...rigging, input: captured })).item; if (item.id !== captured.id || item.promotionId !== captured.promotionId) throw new HubProtocolError(); return item; },
      addCaptured: async input => { const captured = RiggingEntrySchema.parse(input); const item = (await request('rigging-add-captured', 'shared-rigging-view-v1', { ...rigging, input: captured })).item; if (item.item.id !== captured.id) throw new HubProtocolError(); return item; },
      items: async (runtime, projectId) => (await request('rigging-items', 'shared-rigging-items-v1', { ...rigging, runtime, projectId })).items,
    };
  }
}
