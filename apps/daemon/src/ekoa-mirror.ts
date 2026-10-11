import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EkoaConnectionSchema, EkoaMirrorSchema, EkoaRequestSchema, EkoaSettingsSchema, EkoaStateSchema, ProjectDecisionSchema, ProjectSchema, ProjectWorkTaskSchema as TaskSchema, ThreadIndexSchema,
  newId, stableJson, type EkoaMirror, type EkoaRequest } from '@jevellan/core';
import { settingsMutation, type HubDatabase } from '@jevellan/mesh';
import { connectEkoa, type EkoaClient, type EkoaConnector } from './ekoa-client.js';
type Desired = { kind: EkoaMirror['kind']; id: string; projectId: string; title: string; notes: string; allowCreate: boolean };
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const markerText = (record: EkoaMirror) => `[Jevellan mirror v1: ${record.marker}]`;
const TaskData = z.object({ id: z.string().min(1).max(200), notes: z.string().optional(), status: z.enum(['open', 'done']).optional() }).passthrough();
const TasksData = z.object({ tasks: z.array(TaskData).max(200), nextCursor: z.string().nullable().optional() }).passthrough();
const LabelsData = z.object({ labels: z.array(z.object({ name: z.string() }).passthrough()).max(200) }).passthrough();
export class EkoaMirrorService {
  #work: Promise<void> | undefined; #timer: ReturnType<typeof setInterval> | undefined; #closed = false;
  constructor(private readonly hub: HubDatabase, private readonly hubUrl: () => string, private readonly connector: EkoaConnector = connectEkoa, private readonly now = Date.now) {}
  state() {
    return EkoaStateSchema.parse({ schema: 'ekoa-state-v1', settings: this.settings(), tokenSaved: !!this.hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('ekoa'),
      connection: this.hub.get('ekoa-connection', 'current', EkoaConnectionSchema)?.document ?? null,
      mirrors: this.hub.list('ekoa-mirrors', EkoaMirrorSchema).map(row => row.document).slice(-2000) });
  }
  settings() { return this.hub.get('ekoa-settings', 'current', EkoaSettingsSchema)?.document ?? EkoaSettingsSchema.parse({ schema: 'ekoa-settings-v1', revision: 0, url: '', enabled: false }); }
  async request(raw: EkoaRequest, deviceId: string) {
    const request = EkoaRequestSchema.parse(raw);
    if (request.operation === 'save') {
      const input = request.input; if (input.token) this.hub.redactor.add(input.token);
      const settings = settingsMutation(this.hub, deviceId, 'ekoa-settings', input, input.clientRequestId, EkoaSettingsSchema, () => {
        if (input.removeToken) this.hub.vault.remove('ekoa'); else if (input.token) this.hub.vault.put('ekoa', input.token);
        return this.hub.put('ekoa-settings', 'current', EkoaSettingsSchema, { schema: 'ekoa-settings-v1', revision: input.revision + 1, url: input.url, enabled: input.enabled }, input.revision).document;
      });
      void settings; this.kick();
    } else if (request.operation === 'test') await this.test();
    return this.state();
  }
  #saveConnection(status: 'connected' | 'blocked' | 'unavailable', tools: string[], reason?: string, settingsRevision = this.settings().revision) {
    if (settingsRevision !== this.settings().revision) return;
    const current = this.hub.get('ekoa-connection', 'current', EkoaConnectionSchema);
    const attempts = status === 'connected' ? 0 : (current?.document.settingsRevision === settingsRevision ? current.document.attempts : 0) + 1;
    this.hub.put('ekoa-connection', 'current', EkoaConnectionSchema, { settingsRevision, attempts, retryAt: attempts ? new Date(this.now() + Math.min(3_600_000, 15_000 * 2 ** Math.min(attempts - 1, 8))).toISOString() : null, schema: 'ekoa-connection-v1', at: new Date(this.now()).toISOString(), status, tools,
      ...(reason ? { reason: this.hub.redactor.text(reason).slice(0, 1200) } : {}) }, current?.revision ?? 0);
  }
  async #connect(settings = this.settings()) { if (!settings.url) throw new Error('Add the Ekoa MCP URL in Settings.');
    if (!this.hub.db.prepare('SELECT id FROM secrets WHERE id=?').get('ekoa')) throw new Error('Add the Ekoa token in Settings.');
    return this.connector(settings.url, this.hub.vault.forLaunch('ekoa'));
  }
  async test() {
    let client: EkoaClient | undefined; const settings = this.settings();
    try { client = await this.#connect(settings); this.#saveConnection('connected', [...client.tools], undefined, settings.revision); }
    catch (error) { this.#saveConnection('blocked', [], this.#error(error), settings.revision); }
    finally { await client?.close().catch(() => undefined); }
    return this.state();
  }
  #error(error: unknown) {
    const raw = error instanceof Error ? error.message : 'Ekoa did not complete the operation.';
    if (/401|Unauthorized|invalid.token|expired|Sign in to Ekoa/iu.test(raw)) return 'Ekoa rejected the saved bearer token. Its MCP requires an OAuth access token with ekoa.read and ekoa.write; replace or reconnect it in Settings. No interactive daemon authentication or refresh token is configured.';
    return this.hub.redactor.text(raw).slice(0, 1200);
  }
  start() { if (!this.#timer) { this.#timer = setInterval(() => this.kick(), 15_000); this.#timer.unref(); this.kick(); } }
  kick() { void this.tick().catch(() => undefined); }
  tick(): Promise<void> { if (this.#closed) return Promise.resolve(); return this.#work ??= this.#sweep().finally(() => { this.#work = undefined; }); }
  async close() { this.#closed = true; clearInterval(this.#timer); await this.#work?.catch(() => undefined); }
  #wanted(endpoint: string): Map<string, Desired> {
    const wanted = new Map<string, Desired>();
    const add = (item: Desired) => { const id = `em_${hash([endpoint, item.kind, item.id]).slice(0, 40)}`; wanted.set(id, { ...item, title: this.hub.redactor.text(item.title).slice(0, 200), notes: this.hub.redactor.text(item.notes).slice(0, 19_000) }); };
    for (const { document: project } of this.hub.list('projects', ProjectSchema)) {
      const link = `${this.hubUrl()}/projects/${encodeURIComponent(project.id)}`;
      for (const { document: decision } of this.hub.listByField('project-decisions', 'projectId', project.id, ProjectDecisionSchema)) if (!decision.answeredAt && !decision.withdrawnAt) {
        const thread = decision.merge && decision.threadId ? this.hub.get('project-threads', decision.threadId, ThreadIndexSchema)?.document : undefined;
        if (decision.merge && (thread?.projectId !== project.id || thread.pr?.state !== 'open' || thread.pr.headSha !== decision.merge.commit)) continue;
        const title = decision.merge ? decision.question.replace(/^Merge /u, 'merge ').replace(/\?$/u, '') : decision.question;
        add({ kind: 'decision', id: decision.id, projectId: project.id, title: `Jevellan · ${project.name}: ${title.slice(0, 80)}`,
          notes: `${decision.question}\n${decision.merge ? `Checked commit: ${decision.merge.commit}\n${thread?.pr?.url ?? ''}\n` : ''}${decision.options.map(option => `- ${option.label}${option.detail ? `: ${option.detail}` : ''}`).join('\n')}\n\nAnswer in Jevellan: ${link}`, allowCreate: true });
      }
      const drafts = this.hub.listByField('project-work-tasks', 'projectId', project.id, TaskSchema).map(row => row.document).filter(task => task.state === 'draft');
      if (drafts.length) add({ kind: 'drafts', id: project.id, projectId: project.id, title: `Jevellan · ${project.name}: ${drafts.length} proposed tasks`,
        notes: `${drafts.map(task => `- ${task.title}: ${task.brief}`).join('\n\n')}\n\nApprove in Jevellan: ${link}`, allowCreate: true });
    }
    return wanted;
  }
  #put(record: EkoaMirror) {
    const old = this.hub.get('ekoa-mirrors', record.id, EkoaMirrorSchema); return this.hub.put('ekoa-mirrors', record.id, EkoaMirrorSchema, record, old?.revision ?? 0).document;
  }
  async #owned(client: EkoaClient, record: EkoaMirror) {
    const result = await client.call('task_get', { id: record.ekoaTaskId }); const data = TaskData.parse(result.data);
    if (data.id !== record.ekoaTaskId || !(data.notes ?? result.externalText).includes(markerText(record))) throw new Error('This Ekoa task no longer carries Jevellan’s ownership marker; it will not be changed.');
    return data;
  }
  async #recover(client: EkoaClient, record: EkoaMirror) {
    let cursor: string | undefined; const cursors = new Set<string>(); const found: string[] = [];
    do {
      const result = TasksData.parse((await client.call('tasks_list', { search: markerText(record), status: 'all', limit: 200, ...(cursor ? { cursor } : {}) })).data);
      for (const row of result.tasks) {
        const probe = { ...record, ekoaTaskId: row.id };
        try { await this.#owned(client, probe); found.push(row.id); } catch { /* Never adopt an unrelated search hit. */ }
      }
      if (result.nextCursor && cursors.has(result.nextCursor) || cursors.size >= 10) throw new Error('Ekoa repeated or exceeded the task search cursor limit.');
      if (result.nextCursor) cursors.add(result.nextCursor); cursor = result.nextCursor ?? undefined;
      if (found.length > 1) throw new Error('More than one Ekoa task carries this mirror marker; resolve the duplicate before retrying.');
    } while (cursor);
    return found[0];
  }
  async #sync(client: EkoaClient, initial: EkoaMirror, desired: Desired | undefined) {
    let record = initial;
    if (!record.ekoaTaskId && record.createAttempted) {
      const recovered = await this.#recover(client, record);
      if (!recovered) throw new Error('The Ekoa create response was lost. Waiting to recover its task; creation will not be repeated.');
      record = this.#put({ ...record, ekoaTaskId: recovered, state: 'open' });
    }
    if (!record.ekoaTaskId) {
      if (!desired?.allowCreate) return;
      record = this.#put({ ...record, createAttempted: true, updatedAt: new Date(this.now()).toISOString() });
      const made = TaskData.parse((await client.call('task_create', { title: desired.title, notes: `${desired.notes}\n\n${markerText(record)}`, labels: ['Jevellan'] })).data);
      record = this.#put({ ...record, ekoaTaskId: made.id, state: 'open' });
    }
    const owned = await this.#owned(client, record);
    if (!desired) {
      if (owned.status !== 'done') await client.call('task_complete', { id: record.ekoaTaskId });
      this.#put({ ...record, state: 'completed', attempts: 0, retryAt: null, error: undefined, updatedAt: new Date(this.now()).toISOString() }); return;
    }
    const digest = hash({ title: desired.title, notes: desired.notes });
    if (owned.status === 'done' && desired.allowCreate) await client.call('task_reopen', { id: record.ekoaTaskId });
    if (record.payloadDigest !== digest) await client.call('task_update', { id: record.ekoaTaskId, title: desired.title, notes: `${desired.notes}\n\n${markerText(record)}`, labels: ['Jevellan'] });
    this.#put({ ...record, title: desired.title, state: owned.status === 'done' && !desired.allowCreate ? 'completed' : 'open', payloadDigest: digest, attempts: 0, retryAt: null, error: undefined, updatedAt: new Date(this.now()).toISOString() });
  }
  async #sweep() {
    const settings = this.settings(); if (!settings.enabled) return;
    const connection = this.state().connection; if (connection?.settingsRevision === settings.revision && connection.retryAt && Date.parse(connection.retryAt) > this.now()) return;
    let client: EkoaClient | undefined;
    try {
      client = await this.#connect(settings); const connected = client;
      client = { ...connected, call: async (name, args) => { if (this.settings().revision !== settings.revision || this.#closed) throw new Error('Ekoa settings changed; the previous mirror operation stopped.'); return connected.call(name, args); } };
      this.#saveConnection('connected', [...client.tools], undefined, settings.revision);
      const labels = LabelsData.parse((await client.call('labels_list', {})).data);
      if (!labels.labels.some(label => label.name === 'Jevellan')) {
        try { await client.call('label_create', { name: 'Jevellan' }); }
        catch (error) { if (!LabelsData.parse((await client.call('labels_list', {})).data).labels.some(label => label.name === 'Jevellan')) throw error; }
      }
      const wanted = this.#wanted(settings.url);
      for (const [id, desired] of wanted) if (desired.allowCreate && !this.hub.get('ekoa-mirrors', id, EkoaMirrorSchema)) this.#put({ schema: 'ekoa-mirror-v1', id, projectId: desired.projectId,
        kind: desired.kind, jevellanId: desired.id, title: desired.title, endpoint: settings.url, marker: newId('emarker'), ekoaTaskId: null, state: 'pending', createAttempted: false, payloadDigest: null, attempts: 0, retryAt: null, updatedAt: new Date(this.now()).toISOString() });
      for (const { document: record } of this.hub.list('ekoa-mirrors', EkoaMirrorSchema)) {
        if (record.endpoint !== settings.url || record.retryAt && Date.parse(record.retryAt) > this.now()) continue;
        if (record.state === 'completed' && !wanted.has(record.id)) continue;
        try { await this.#sync(client, record, wanted.get(record.id)); }
        catch (error) { const latest = this.hub.get('ekoa-mirrors', record.id, EkoaMirrorSchema)!.document; const attempts = latest.attempts + 1;
          this.#put({ ...latest, attempts, error: this.#error(error), retryAt: new Date(this.now() + Math.min(3_600_000, 15_000 * 2 ** Math.min(attempts - 1, 8))).toISOString(), updatedAt: new Date(this.now()).toISOString() }); }
      }
    } catch (error) { this.#saveConnection('blocked', [], this.#error(error), settings.revision); }
    finally { await client?.close().catch(() => undefined); }
  }
}
