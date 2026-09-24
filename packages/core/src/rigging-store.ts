import { z } from 'zod';
import { IdSchema, RiggingItemSchema, TimestampSchema, type RiggingItem } from './schemas.js';
import { newId } from './models.js';
import type { DocumentStore } from './store.js';
import type { SecretRedactor } from './environment.js';

export const RiggingEntrySchema = z.strictObject({
  schema: z.literal('rigging-entry-v1'), id: IdSchema, name: z.string().trim().min(1).max(128),
  kind: RiggingItemSchema.shape.kind, state: RiggingItemSchema.shape.state,
  runtimes: z.record(IdSchema, z.boolean()), builtIn: z.boolean(), content: z.string().max(1024 * 1024),
  packageRef: z.string().min(1).max(2048).optional(), updatedAt: TimestampSchema,
});
export const AddRiggingSchema = z.strictObject({
  schema: z.literal('add-rigging-v1'), name: RiggingEntrySchema.shape.name, kind: RiggingItemSchema.shape.kind,
  runtimes: RiggingEntrySchema.shape.runtimes, content: RiggingEntrySchema.shape.content,
  packageRef: RiggingEntrySchema.shape.packageRef,
});
export const UpdateRiggingSchema = z.strictObject({
  schema: z.literal('update-rigging-v1'), revision: z.number().int().positive(), name: RiggingEntrySchema.shape.name,
  runtimes: RiggingEntrySchema.shape.runtimes, content: RiggingEntrySchema.shape.content, state: RiggingEntrySchema.shape.state,
});
export const RiggingViewSchema = z.strictObject({ schema: z.literal('rigging-view-v1'), revision: z.number().int().positive(), item: RiggingEntrySchema });

export class RiggingStore {
  constructor(private readonly store: DocumentStore, private readonly redactor: SecretRedactor, private readonly runtimes: readonly string[]) {
    if (!store.get('rigging', 'builtin_safety', RiggingEntrySchema)) store.put('rigging', 'builtin_safety', RiggingEntrySchema, {
      schema: 'rigging-entry-v1', id: 'builtin_safety', name: 'Safety', kind: 'hook', state: 'owned', builtIn: true,
      runtimes: Object.fromEntries(runtimes.map((id) => [id, true])), content: 'Always on. Blocks destructive shell commands and daemon control. Runtime permission controls and after-stretch git checks also apply.', updatedAt: new Date().toISOString(),
    }, 0);
  }
  #validate(value: z.infer<typeof AddRiggingSchema> | z.infer<typeof UpdateRiggingSchema>): void {
    for (const runtime of Object.keys(value.runtimes)) if (!this.runtimes.includes(runtime)) throw new Error('This runtime is not installed.');
    if (this.redactor.text(value.content) !== value.content) throw new Error('Store credentials in Accounts, not in Rigging content.');
  }
  get(id: string) {
    const row = this.store.get('rigging', id, RiggingEntrySchema);
    if (!row) throw Object.assign(new Error('Rigging item not found.'), { status: 404 });
    return RiggingViewSchema.parse({ schema: 'rigging-view-v1', revision: row.revision, item: row.document });
  }
  list() { return this.store.list('rigging', RiggingEntrySchema).map((row) => RiggingViewSchema.parse({ schema: 'rigging-view-v1', revision: row.revision, item: row.document })); }
  add(input: unknown) {
    const value = AddRiggingSchema.parse(input); this.#validate(value);
    const item = RiggingEntrySchema.parse({ ...value, schema: 'rigging-entry-v1', id: newId('rig'), state: 'owned', builtIn: false, updatedAt: new Date().toISOString() });
    this.store.put('rigging', item.id, RiggingEntrySchema, item, 0); return this.get(item.id);
  }
  update(id: string, input: unknown) {
    const value = UpdateRiggingSchema.parse(input); this.#validate(value); const current = this.get(id);
    if (current.item.builtIn) throw new Error('This built-in item is always on and cannot be edited.');
    if (current.item.packageRef && (value.content !== current.item.content || value.name !== current.item.name)) throw new Error('Package-managed content is read-only.');
    const item = RiggingEntrySchema.parse({ ...current.item, name: value.name, content: value.content, runtimes: value.runtimes, state: value.state, updatedAt: new Date().toISOString() });
    this.store.put('rigging', id, RiggingEntrySchema, item, value.revision); return this.get(id);
  }
  items(runtime: string): RiggingItem[] {
    return this.list().filter((row) => row.item.id !== 'builtin_safety').map(({ item }) => RiggingItemSchema.parse({
      schema: 'rigging-item-v1', id: item.id, runtime, name: item.name, kind: item.kind, state: item.state,
      enabled: item.runtimes[runtime] === true, builtIn: item.builtIn, content: item.content,
      ...(item.packageRef ? { packageRef: item.packageRef } : {}), updatedAt: item.updatedAt,
    }));
  }
}
