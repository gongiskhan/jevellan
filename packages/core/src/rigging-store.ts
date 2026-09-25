import { z } from 'zod';
import { createHash } from 'node:crypto';
import { stableJson } from './files.js';
import { RiggingItemSchema, type RiggingItem } from './schemas.js';
import { RiggingEntrySchema, RiggingViewSchema, AddRiggingSchema, UpdateRiggingSchema } from './client-schemas.js';
import { newId } from './models.js';
import type { DocumentStore } from './store.js';
import type { SecretRedactor } from './environment.js';
import { McpRiggingSchema, supportedRigging } from './rigging.js';
import { PROJECT_MEMORY_ID, PROJECT_MEMORY_DESCRIPTION, projectMemoryHooks } from './project-memory-rigging.js';


export class RiggingStore {
  constructor(private readonly store: DocumentStore, private readonly redactor: SecretRedactor, private readonly runtimes: readonly string[]) {
    if (!store.get('rigging', 'builtin_safety', RiggingEntrySchema)) store.put('rigging', 'builtin_safety', RiggingEntrySchema, {
      schema: 'rigging-entry-v1', id: 'builtin_safety', name: 'Safety', kind: 'hook', state: 'owned', builtIn: true,
      runtimes: Object.fromEntries(runtimes.map((id) => [id, true])), content: 'Always on. Blocks destructive shell commands and daemon control. Runtime permission controls and after-stretch git checks also apply.', updatedAt: new Date().toISOString(),
    }, 0);
    if (!store.get('rigging', PROJECT_MEMORY_ID, RiggingEntrySchema)) store.put('rigging', PROJECT_MEMORY_ID, RiggingEntrySchema, {
      schema: 'rigging-entry-v1', id: PROJECT_MEMORY_ID, name: 'Project memory', kind: 'hook', state: 'owned', builtIn: true,
      runtimes: Object.fromEntries(runtimes.map((id) => [id, true])), content: PROJECT_MEMORY_DESCRIPTION, updatedAt: new Date().toISOString(),
    }, 0);
  }
  #validate(value: z.infer<typeof AddRiggingSchema> | z.infer<typeof UpdateRiggingSchema>, kind: RiggingItem['kind'], packageManaged = false): void {
    for (const runtime of Object.keys(value.runtimes)) if (!this.runtimes.includes(runtime)) throw new Error('This runtime is not installed.');
    if (this.redactor.text(value.content) !== value.content) throw new Error('Store credentials in Accounts, not in Rigging content.');
    if (!packageManaged && ['mcp', 'hook', 'setting'].includes(kind)) {
      try { const parsed: unknown = JSON.parse(value.content); if (kind === 'mcp') McpRiggingSchema.parse(parsed); else z.record(z.string(), z.unknown()).parse(parsed); }
      catch { throw new Error('Enter valid JSON for this Rigging item.'); }
    }
  }
  #view(row: { revision: number; document: z.infer<typeof RiggingEntrySchema> }) {
    const { bundle, ...item } = row.document; delete item.promotionId;
    return RiggingViewSchema.parse({ schema: 'rigging-view-v1', revision: row.revision, item: { ...item, ...(bundle ? { bundle: { schema: 'rigging-bundle-summary-v1', name: bundle.name, fileCount: bundle.files.length, digest: createHash('sha256').update(stableJson(bundle)).digest('hex') } } : {}) } });
  }
  get(id: string) {
    const row = this.store.get('rigging', id, RiggingEntrySchema);
    if (!row) throw Object.assign(new Error('Rigging item not found.'), { status: 404 });
    return this.#view(row);
  }
  list() { return this.store.list('rigging', RiggingEntrySchema).map((row) => this.#view(row)); }
  validateCaptured(raw: unknown) {
    const item = RiggingEntrySchema.parse(raw);
    if (!item.promotionId || !item.bundle || item.builtIn || item.packageRef || !['skill', 'rule', 'command'].includes(item.kind) || item.state !== 'owned') throw new Error('Invalid captured Rigging item.');
    this.#validate({ schema: 'add-rigging-v1', name: item.name, kind: item.kind, content: item.content, runtimes: item.runtimes }, item.kind);
    if (!Object.values(item.runtimes).some(Boolean)) throw new Error('Choose at least one runtime.');
    for (const [runtime, enabled] of Object.entries(item.runtimes)) if (enabled && (!(runtime === 'claude' || runtime === 'codex') || !supportedRigging(runtime).includes(item.kind))) throw new Error('This kind is not supported by the selected runtime.');
    if (item.kind !== 'skill' && item.bundle.files.length) throw new Error('Only skills can carry bundled files.');
    for (const file of item.bundle.files) {
      const bytes = Buffer.from(file.base64, 'base64');
      if (bytes.toString('base64') !== file.base64 || this.redactor.text(file.ref) !== file.ref || this.redactor.text(bytes.toString('utf8')) !== bytes.toString('utf8')) throw new Error('This bundle contains credentials or invalid file data.');
    }
    return item;
  }
  addCaptured(raw: unknown) {
    const item = this.validateCaptured(raw); const current = this.store.get('rigging', item.id, RiggingEntrySchema);
    if (current && current.document.promotionId !== item.promotionId) throw new Error('This managed item belongs to another promotion.');
    if (!current) this.store.put('rigging', item.id, RiggingEntrySchema, item, 0);
    return this.get(item.id);
  }
  add(input: unknown) {
    const value = AddRiggingSchema.parse(input); this.#validate(value, value.kind, Boolean(value.packageRef));
    const item = RiggingEntrySchema.parse({ ...value, schema: 'rigging-entry-v1', id: newId('rig'), state: 'owned', builtIn: false, updatedAt: new Date().toISOString() });
    this.store.put('rigging', item.id, RiggingEntrySchema, item, 0); return this.get(item.id);
  }
  update(id: string, input: unknown) {
    const value = UpdateRiggingSchema.parse(input); const row = this.store.get('rigging', id, RiggingEntrySchema);
    if (!row) throw Object.assign(new Error('Rigging item not found.'), { status: 404 });
    const current = { item: row.document };
    if (current.item.id === 'builtin_safety') throw new Error('This built-in item is always on and cannot be edited.');
    if (current.item.builtIn && (value.name !== current.item.name || value.content !== current.item.content || value.state !== 'owned')) throw new Error('Built-in content is read-only. Use its runtime toggles.');
    this.#validate(value, current.item.kind, Boolean(current.item.packageRef));
    if (current.item.packageRef && (value.content !== current.item.content || value.name !== current.item.name)) throw new Error('Package-managed content is read-only.');
    const item = RiggingEntrySchema.parse({ ...current.item, name: value.name, content: value.content, runtimes: value.runtimes, state: value.state, updatedAt: new Date().toISOString() });
    this.store.put('rigging', id, RiggingEntrySchema, item, value.revision); return this.get(id);
  }
  items(runtime: string): RiggingItem[] {
    return this.store.list('rigging', RiggingEntrySchema).filter((row) => row.document.id !== 'builtin_safety').map(({ document: item }) => RiggingItemSchema.parse({
      schema: 'rigging-item-v1', id: item.id, runtime, name: item.name, kind: item.kind, state: item.state,
      enabled: item.runtimes[runtime] === true, builtIn: item.builtIn, content: item.id === PROJECT_MEMORY_ID ? JSON.stringify(projectMemoryHooks()) : item.content,
      ...(item.packageRef ? { packageRef: item.packageRef } : {}), ...(item.bundle ? { bundle: item.bundle } : {}), updatedAt: item.updatedAt,
    }));
  }
}
