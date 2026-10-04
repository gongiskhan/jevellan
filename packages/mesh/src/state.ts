import {
  CheckoutClaimSchema, ConfigWriteSchema, ConversationIndexSchema, CredentialInputSchema, GitHubTokenStateSchema, IdSchema, ProjectSchema, ProjectViewSchema, RiggingEntrySchema, RiggingStore, SecretSummarySchema, SharedStateRequestSchema, SharedStateResultSchema, ThreadIndexSchema, isTerminal, stableJson,
  type GitHubTokenState, type Project, type SharedConfiguration, type SharedGitHub, type SharedJev, type SharedProjects, type SharedRigging,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { HubProtocolError, type MemberHubClient } from './client.js';
import { HubRigging } from './rigging.js';
import { settingsMutation } from './settings-mutation.js';

export class HubState {
  readonly configuration: SharedConfiguration;
  readonly projects: SharedProjects;
  readonly jev: SharedJev;
  readonly github: SharedGitHub;
  readonly rigging: RiggingStore;
  constructor(readonly hub: HubDatabase, readonly deviceId: string, runtimes: readonly string[]) {
    IdSchema.parse(deviceId); this.rigging = new HubRigging(hub, deviceId, runtimes);
    const clean = (value: unknown) => { if (hub.redactor.text(JSON.stringify(value)) !== JSON.stringify(value)) throw new Error('Store credentials in their Settings fields.'); };
    const projectView = (row: { revision: number; document: Project }) => ProjectViewSchema.parse({ schema: 'project-view-v1', revision: row.revision, project: row.document });
    this.configuration = {
      current: () => { const revision = hub.configuration.current(); if (!revision) throw new Error('Configuration has not been initialized.'); return revision; },
      history: () => hub.configuration.history(),
      put: raw => { const input = ConfigWriteSchema.parse(raw); clean(input.configuration); return hub.configuration.put(input.configuration, input.revision, { deviceId, source: 'ui' }, undefined, input.clientRequestId); },
    };
    this.projects = {
      get: id => { const row = hub.get('projects', IdSchema.parse(id), ProjectSchema); return row ? projectView(row) : null; },
      list: () => hub.list('projects', ProjectSchema).map(projectView),
      put: (raw, revision, clientRequestId) => {
        const project = ProjectSchema.parse(raw); clean(project);
        return settingsMutation(hub, deviceId, 'project-put', { project, revision }, clientRequestId, ProjectViewSchema, () => {
          const previous = hub.get('projects', project.id, ProjectSchema)?.document;
          if (previous && hub.list('checkout-ownership', CheckoutClaimSchema).some(({ document: claim }) => claim.held && (previous.paths[claim.deviceId] === claim.path || hub.get('conversations', claim.conversationId, ConversationIndexSchema)?.document.projectId === project.id))) throw Object.assign(new Error('This project is in use. Finish its open work before changing its settings.'), { status: 409 });
          // D92: worktree threads hold no checkout claim, so paths and Git policy stay fixed while any thread is open.
          if (previous && (stableJson(previous.paths) !== stableJson(project.paths) || previous.branchPolicy !== project.branchPolicy) && hub.listByField('project-threads', 'projectId', project.id, ThreadIndexSchema).some(({ document: thread }) => !isTerminal(thread.state))) throw Object.assign(new Error('This project has open threads. Stop or finish them before changing its path or Git policy.'), { status: 409 });
          return projectView(hub.put('projects', project.id, ProjectSchema, project, revision));
        });
      },
      context: (id, context, revision) => {
        const current = hub.get('projects', IdSchema.parse(id), ProjectSchema); if (!current) throw Object.assign(new Error('Project not found.'), { status: 404 });
        return projectView(hub.put('projects', id, ProjectSchema, { ...current.document, context: ProjectSchema.shape.context.parse(context) }, revision));
      },
    };
    this.jev = {
      summary: () => hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('jev') ? hub.vault.summary('jev') : { schema: 'secret-state-v1', id: 'jev', saved: false },
      put: (raw, clientRequestId) => {
        const value = CredentialInputSchema.parse(raw);
        settingsMutation(hub, deviceId, 'jev-put', { value }, clientRequestId, SecretSummarySchema, () => hub.vault.put('jev', value));
        return hub.vault.summary('jev');
      },
      credential: () => { if (!hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('jev')) return undefined; return hub.vault.forLaunch('jev'); },
    };
    const github = (): GitHubTokenState => hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('github') ? { schema: 'github-token-summary-v1', id: 'github', saved: true, ...hub.vault.details('github') } : { schema: 'secret-state-v1', id: 'github', saved: false };
    this.github = {
      summary: github,
      put: (raw, clientRequestId) => {
        const value = CredentialInputSchema.parse(raw);
        settingsMutation(hub, deviceId, 'github-put', { value }, clientRequestId, GitHubTokenStateSchema, () => { hub.vault.put('github', value); return github(); });
        return github();
      },
      remove: (clientRequestId) => { settingsMutation(hub, deviceId, 'github-remove', {}, clientRequestId, GitHubTokenStateSchema, () => { hub.vault.remove('github'); return github(); }); return github(); },
      credential: () => { if (!hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('github')) return undefined; return hub.vault.forLaunch('github'); },
    };
  }
  async request(raw: unknown) {
    const request = SharedStateRequestSchema.parse(raw); let result: unknown;
    switch (request.operation) {
      case 'configuration': result = { schema: 'shared-configuration-v1', revision: await this.configuration.current() }; break;
      case 'configuration-history': result = { schema: 'shared-configuration-history-v1', revisions: await this.configuration.history() }; break;
      case 'configuration-put': result = { schema: 'shared-configuration-v1', revision: await this.configuration.put(request.input) }; break;
      case 'project': result = { schema: 'shared-project-v1', project: await this.projects.get(request.id) }; break;
      case 'projects': result = { schema: 'shared-projects-v1', projects: await this.projects.list() }; break;
      case 'project-put': result = { schema: 'shared-project-v1', project: await this.projects.put(request.project, request.revision, request.clientRequestId) }; break;
      case 'project-context': result = { schema: 'shared-project-v1', project: await this.projects.context(request.id, request.context, request.revision) }; break;
      case 'jev-summary': result = { schema: 'shared-jev-summary-v1', summary: await this.jev.summary() }; break;
      case 'jev-put': result = { schema: 'shared-jev-summary-v1', summary: await this.jev.put(request.value, request.clientRequestId) }; break;
      case 'jev-credential': result = { schema: 'shared-jev-credential-v1', value: await this.jev.credential() ?? null }; break;
      case 'github-summary': result = { schema: 'shared-github-summary-v1', summary: await this.github.summary() }; break;
      case 'github-put': result = { schema: 'shared-github-summary-v1', summary: await this.github.put(request.value, request.clientRequestId) }; break;
      case 'github-remove': result = { schema: 'shared-github-summary-v1', summary: await this.github.remove(request.clientRequestId) }; break;
      case 'github-credential': result = { schema: 'shared-github-credential-v1', value: await this.github.credential() ?? null }; break;
      case 'rigging': result = { schema: 'shared-rigging-v1', items: this.rigging.list() }; break;
      case 'rigging-get': result = { schema: 'shared-rigging-view-v1', item: this.rigging.get(request.id) }; break;
      case 'rigging-add': result = { schema: 'shared-rigging-view-v1', item: this.rigging.add(request.input) }; break;
      case 'rigging-update': result = { schema: 'shared-rigging-view-v1', item: this.rigging.update(request.id, request.input) }; break;
      case 'rigging-validate-captured': result = { schema: 'shared-rigging-entry-v1', item: this.rigging.validateCaptured(request.input) }; break;
      case 'rigging-add-captured': result = { schema: 'shared-rigging-view-v1', item: this.rigging.addCaptured(request.input) }; break;
      case 'rigging-items': result = { schema: 'shared-rigging-items-v1', items: this.rigging.items(request.runtime) }; break;
    }
    return SharedStateResultSchema.parse(result);
  }
}

export class MemberState {
  readonly configuration: SharedConfiguration;
  readonly projects: SharedProjects;
  readonly jev: SharedJev;
  readonly github: SharedGitHub;
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
    };
    const writtenProject = async (operation: string, fields: object, id: string, revision: number) => { const result = (await request(operation, 'shared-project-v1', fields)).project; if (!result || result.project.id !== id || result.revision !== revision + 1) throw new HubProtocolError(); return result; };
    this.projects = {
      get: async id => { const result = (await request('project', 'shared-project-v1', { id })).project; if (result && result.project.id !== id) throw new HubProtocolError(); return result; },
      list: async () => (await request('projects', 'shared-projects-v1')).projects,
      put: (project, revision, clientRequestId) => writtenProject('project-put', { project, revision, clientRequestId }, project.id, revision),
      context: (id, context, revision) => writtenProject('project-context', { id, context, revision }, id, revision),
    };
    this.jev = {
      summary: async () => { const summary = (await request('jev-summary', 'shared-jev-summary-v1')).summary; if (summary.id !== 'jev') throw new HubProtocolError(); return summary; },
      put: async (value, clientRequestId) => { const summary = (await request('jev-put', 'shared-jev-summary-v1', { value, clientRequestId })).summary; if (!summary.saved || summary.id !== 'jev') throw new HubProtocolError(); return summary; },
      credential: async () => (await request('jev-credential', 'shared-jev-credential-v1')).value ?? undefined,
    };
    // Saves and removals return the current state, which a later write from another device may already have changed.
    const github = async (operation: string, fields = {}) => { const summary = (await request(operation, 'shared-github-summary-v1', fields)).summary; if (summary.id !== 'github') throw new HubProtocolError(); return summary; };
    this.github = {
      summary: () => github('github-summary'),
      put: (value, clientRequestId) => github('github-put', { value, clientRequestId }),
      remove: (clientRequestId) => github('github-remove', { clientRequestId }),
      credential: async () => (await request('github-credential', 'shared-github-credential-v1')).value ?? undefined,
    };
    this.rigging = {
      get: async id => { const item = (await request('rigging-get', 'shared-rigging-view-v1', { ...rigging, id })).item; if (item.item.id !== id) throw new HubProtocolError(); return item; },
      list: async () => (await request('rigging', 'shared-rigging-v1', rigging)).items,
      add: async input => (await request('rigging-add', 'shared-rigging-view-v1', { ...rigging, input })).item,
      update: async (id, input) => { const item = (await request('rigging-update', 'shared-rigging-view-v1', { ...rigging, id, input })).item; if (item.item.id !== id) throw new HubProtocolError(); return item; },
      validateCaptured: async input => { const captured = RiggingEntrySchema.parse(input); const item = (await request('rigging-validate-captured', 'shared-rigging-entry-v1', { ...rigging, input: captured })).item; if (item.id !== captured.id || item.promotionId !== captured.promotionId) throw new HubProtocolError(); return item; },
      addCaptured: async input => { const captured = RiggingEntrySchema.parse(input); const item = (await request('rigging-add-captured', 'shared-rigging-view-v1', { ...rigging, input: captured })).item; if (item.item.id !== captured.id) throw new HubProtocolError(); return item; },
      items: async runtime => (await request('rigging-items', 'shared-rigging-items-v1', { ...rigging, runtime })).items,
    };
  }
}
