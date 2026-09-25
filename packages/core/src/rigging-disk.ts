import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';
import { Homes, resolvedPath } from './homes.js';
import { atomicWrite, readDocument, stableJson, writeDocument } from './files.js';
import { SecretRedactor } from './environment.js';
import { IdSchema, type Account } from './schemas.js';
import { McpRiggingSchema, RiggingDeliveryStateSchema } from './rigging.js';
import { withRiggingHome } from './rigging-lock.js';
import { RiggingEntrySchema } from './client-schemas.js';
import type { SharedRigging } from './shared-state.js';
import { RiggingAddressSchema, RiggingDiskCancelledSchema, RiggingDiskCancelSchema, RiggingDiskDetailSchema, RiggingDiskItemSchema, RiggingDiskListSchema, RiggingDiskResultSchema, RiggingDiskTransitionSchema, RiggingDiskWriteSchema, RiggingPromotionInputSchema, type RiggingAddress, type RiggingDiskItem } from './rigging-disk-schemas.js';

type Runtime = 'claude' | 'codex';
type Selector = NonNullable<RiggingAddress['selector']>;
type Ownership = z.infer<typeof RiggingDeliveryStateSchema>;
type File = { ref: string; hash: string; mode: number };
type Snapshot = { hash: string; files: File[]; updatedAt: string; directory: boolean };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });
const emptyOwnership = (): Ownership => ({ schema: 'rigging-delivery-v1', fingerprint: '', files: {}, claims: {} });
const PromotionSchema = z.strictObject({
  schema: z.literal('rigging-promotion-v1'), request: RiggingPromotionInputSchema, runtime: z.enum(['claude', 'codex']), accountId: IdSchema, itemId: IdSchema,
  status: z.enum(['prepared', 'completed', 'cancelled']), source: RiggingAddressSchema, sourceHash: z.string(), files: z.record(z.string(), z.string()), entry: RiggingEntrySchema,
});
const OperationSchema = z.strictObject({
  schema: z.literal('rigging-disk-operation-v1'), requestId: IdSchema, itemId: IdSchema, runtime: z.enum(['claude', 'codex']), accountId: IdSchema,
  action: z.enum(['park', 'restore']), fingerprint: z.string(), status: z.enum(['prepared', 'completed', 'cancelled']),
  source: RiggingAddressSchema, target: RiggingAddressSchema, sourceBefore: z.string(), sourceAfter: z.string().nullable(), targetBefore: z.string().nullable(), targetAfter: z.string(),
});
type Operation = z.infer<typeof OperationSchema>;

function confined(root: string, ref: string): string {
  if (!ref || isAbsolute(ref) || ref.includes('\\') || ref.includes('\0') || ref.split('/').some((part) => !part || part === '.' || part === '..')) throw failure('Invalid Rigging file reference.', 400);
  let path = root;
  for (const part of ref.split('/')) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) throw failure('Rigging does not follow symbolic links.'); } catch (error) { if (!missing(error)) throw error; }
  }
  if (resolvedPath(path) !== path) throw failure('Rigging files cannot alias another directory.');
  return path;
}
function snapshot(path: string): Snapshot | null {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (missing(error)) return null; throw error; }
  const files: File[] = []; let bytes = 0;
  const walk = (current: string, ref: string) => {
    const value = lstatSync(current);
    if (value.isSymbolicLink() || !value.isDirectory() && !value.isFile()) throw failure('Rigging items must contain regular files, without symbolic links.');
    if (value.isDirectory()) { for (const name of readdirSync(current).sort()) walk(join(current, name), ref ? `${ref}/${name}` : name); return; }
    bytes += value.size; if (files.length >= 256 || bytes > 10 * 1024 * 1024) throw failure('This Rigging item is too large to manage here.');
    files.push({ ref, hash: hash(readFileSync(current)), mode: value.mode & 0o777 });
  };
  walk(path, '');
  return { hash: hash(stableJson(files)), files, directory: stat.isDirectory(), updatedAt: stat.mtime.toISOString() };
}
function fileHash(contents: string, mode: number): string { return hash(stableJson([{ ref: '', hash: hash(contents), mode }])); }
function text(path: string): string {
  const stat = lstatSync(path); if (!stat.isFile() || stat.size > 1024 * 1024) throw failure('Only text files up to 1 MB can be edited here.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); } catch { throw failure('Binary files cannot be edited here.'); }
}
function object(value: unknown): Record<string, unknown> { return z.record(z.string(), z.unknown()).parse(value); }
function config(path: string, ref: string): Record<string, unknown> {
  if (!existsSync(path)) return ref === 'jevellan-mcp.json' ? { schema: 'stable-mcp-v1', servers: {} } : {};
  try { return object(ref.endsWith('.toml') ? parseToml(text(path)) : JSON.parse(text(path))); }
  catch { throw failure(`Cannot read ${ref} as a configuration object. Its original contents were preserved.`, 400); }
}
function encode(value: Record<string, unknown>, ref: string): string { return ref.endsWith('.toml') ? stringifyToml(value) : `${JSON.stringify(value, null, 2)}\n`; }
function get(value: unknown, selector: Selector): unknown {
  for (const key of selector) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) throw failure('The selected Rigging entry no longer exists.');
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
function has(value: unknown, selector: Selector): boolean { try { get(value, selector); return true; } catch { return false; } }
function change(value: Record<string, unknown>, selector: Selector, content: unknown, remove = false): Record<string, unknown> {
  const result = structuredClone(value); let parent: Record<string | number, unknown> | unknown[] = result;
  for (let index = 0; index < selector.length - 1; index++) {
    const key = selector[index]!;
    if (!Object.hasOwn(parent, key)) Object.defineProperty(parent, key, { value: typeof selector[index + 1] === 'number' ? [] : {}, configurable: true, enumerable: true, writable: true });
    const child = (parent as Record<string | number, unknown>)[key];
    if (typeof child !== 'object' || child === null) throw failure('The Rigging configuration structure changed.');
    parent = child as Record<string | number, unknown>;
  }
  const key = selector.at(-1)!;
  if (remove && Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
  else if (remove) delete (parent as Record<string | number, unknown>)[key];
  else Object.defineProperty(parent, key, { value: content, configurable: true, enumerable: true, writable: true });
  return result;
}

/** Account-local inventory; never scans a user's native agent homes. */
export class RiggingDisk {
  constructor(readonly homes: Homes, readonly redactor = new SecretRedactor()) {}
  #home(runtime: Runtime, accountId: string): string {
    return confined(this.homes.root, `homes/${runtime}/${IdSchema.parse(accountId)}`);
  }
  #root(runtime: Runtime, accountId: string, bucket?: string): string {
    return bucket ? confined(this.homes.root, `rigging/parked/${runtime}/${IdSchema.parse(accountId)}/${IdSchema.parse(bucket)}`) : this.#home(runtime, accountId);
  }
  #path(runtime: Runtime, accountId: string, address: RiggingAddress): string { return confined(this.#root(runtime, accountId, address.bucket), address.ref); }
  #ownership(runtime: Runtime, accountId: string): Ownership {
    const path = confined(this.homes.root, `rigging/state/${runtime}/${IdSchema.parse(accountId)}.json`);
    return existsSync(path) ? readDocument(path, RiggingDeliveryStateSchema) : emptyOwnership();
  }
  #alreadyActive(runtime: Runtime, accountId: string, address: RiggingAddress): boolean {
    if (!address.bucket || address.bucket.startsWith('manual_')) return false;
    try {
      const path = this.#path(runtime, accountId, { ...address, bucket: undefined }); if (!existsSync(path)) return false;
      const archive = this.#path(runtime, accountId, address);
      if (!address.selector) return snapshot(path)?.hash === snapshot(archive)?.hash;
      const selected = get(config(archive, address.ref), address.selector); const live = config(path, address.ref);
      if (typeof address.selector.at(-1) === 'number') {
        const values = get(live, address.selector.slice(0, -1)); return Array.isArray(values) && values.some((value) => stableJson(value) === stableJson(selected));
      }
      return stableJson(get(live, address.selector)) === stableJson(selected);
    } catch { return false; }
  }
  #item(runtime: Runtime, accountId: string, address: RiggingAddress, kind: RiggingDiskItem['kind'], name: string, ownership: Ownership, problem?: string): RiggingDiskItem {
    const path = this.#path(runtime, accountId, address); const current = snapshot(path); if (!current) throw failure('Rigging item no longer exists.', 404);
    const expected = Object.entries(ownership.files).filter(([ref]) => ref === address.ref || ref.startsWith(`${address.ref}/`));
    const actual = new Map(current.files.map((file) => [file.ref ? `${address.ref}/${file.ref}` : address.ref, file.hash]));
    const owned = !address.bucket && expected.length > 0;
    const drifted = owned && (expected.some(([ref, value]) => actual.get(ref) !== value) || [...actual.keys()].some((ref) => !Object.hasOwn(ownership.files, ref)));
    return RiggingDiskItemSchema.parse({ schema: 'rigging-disk-item-v1', id: `disk_${hash(stableJson({ runtime, accountId, address }))}`, runtime, accountId, kind, name, address,
      state: address.bucket ? 'parked' : owned ? 'owned' : 'loose', drifted,
      fingerprint: hash(stableJson({ address, files: current.hash, ownership: address.bucket ? null : ownership })), updatedAt: current.updatedAt, fileCount: current.files.length,
      editable: !owned && (!address.bucket || address.bucket.startsWith('manual_')) && !problem, canPark: !address.bucket && (!owned || drifted && !address.selector), ...(problem ? { problem: this.redactor.text(problem) } : {}),
    });
  }
  #scan(runtime: Runtime, accountId: string, bucket: string | undefined, ownership: Ownership, report: (message: string) => void): RiggingDiskItem[] {
    const root = this.#root(runtime, accountId, bucket); if (!existsSync(root)) return [];
    const items: RiggingDiskItem[] = [];
    const add = (ref: string, kind: RiggingDiskItem['kind'], name: string, selector?: Selector, problem?: string) => {
      try {
        const address = { ref, ...(bucket ? { bucket } : {}), ...(selector ? { selector } : {}) };
        if (!this.#alreadyActive(runtime, accountId, address)) items.push(this.#item(runtime, accountId, address, kind, name, ownership, problem));
      }
      catch (error) { report(`${ref}: ${error instanceof Error ? error.message : 'Could not inspect this item.'}`); }
    };
    for (const [folder, kind] of [['skills', 'skill'], ['rules', 'rule'], ['commands', 'command'], ['hooks', 'hook']] as const) {
      try {
        const path = confined(root, folder); if (!existsSync(path)) continue;
        const walk = (directory: string, prefix: string) => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const ref = `${prefix}/${entry.name}`;
            if (entry.isDirectory() && kind !== 'skill') walk(confined(root, ref), ref);
            else add(ref, kind, kind === 'skill' ? entry.name : ref.slice(folder.length + 1));
          }
        };
        walk(path, folder);
      } catch (error) { report(`${folder}: ${error instanceof Error ? error.message : 'Could not inspect this folder.'}`); }
    }
    for (const ref of runtime === 'codex' ? ['AGENTS.md'] : ['CLAUDE.md']) if (existsSync(join(root, ref))) add(ref, 'rule', ref);
    for (const ref of runtime === 'codex' ? ['config.toml', 'hooks.json'] : ['settings.json', 'jevellan-mcp.json']) {
      try {
        const path = confined(root, ref); if (!existsSync(path)) continue;
        const document = config(path, ref);
        for (const [key, value] of Object.entries(document)) {
          if (ref === 'jevellan-mcp.json' && key === 'schema') continue;
          if (key === 'hooks') {
            for (const [event, groups] of Object.entries(object(value))) {
              if (!Array.isArray(groups)) throw failure('Hook groups must be arrays.');
              groups.forEach((_, index) => add(ref, 'hook', `${event} · ${index + 1}`, [key, event, index]));
            }
          } else if (key === 'mcp_servers' || ref === 'jevellan-mcp.json' && key === 'servers') {
            for (const name of Object.keys(object(value))) add(ref, 'mcp', name, [key, name]);
          } else add(ref, 'setting', key, [key]);
        }
        if (!bucket && ownership.files[ref] && hash(readFileSync(path)) !== ownership.files[ref]) add(ref, 'setting', `${ref} · local changes`, undefined, 'This installed configuration was changed outside Rigging. Park the changed copy before applying its managed items again.');
      } catch (error) { add(ref, 'setting', ref, undefined, error instanceof Error ? error.message : 'Could not read this configuration.'); }
    }
    return items;
  }
  list(accounts: ReadonlyArray<Pick<Account, 'id' | 'runtime'>>) {
    const items: RiggingDiskItem[] = []; const errors: Array<{ runtime: string; accountId: string; message: string }> = [];
    const pending: z.infer<typeof RiggingDiskListSchema>['pending'] = [];
    const promotions: z.infer<typeof RiggingDiskListSchema>['promotions'] = [];
    for (const account of accounts) {
      const runtime = account.runtime; if (runtime !== 'claude' && runtime !== 'codex') continue;
      const report = (message: string) => errors.push({ runtime, accountId: account.id, message: this.redactor.text(message) });
      try {
        const ownership = this.#ownership(runtime, account.id); items.push(...this.#scan(runtime, account.id, undefined, ownership, report));
        const parked = confined(this.homes.root, `rigging/parked/${runtime}/${IdSchema.parse(account.id)}`);
        if (existsSync(parked)) for (const bucket of readdirSync(parked)) {
          try { IdSchema.parse(bucket); items.push(...this.#scan(runtime, account.id, bucket, emptyOwnership(), report)); } catch (error) { report(error instanceof Error ? error.message : 'Could not inspect parked items.'); }
        }
        const operations = confined(this.homes.root, `rigging/operations/${runtime}/${IdSchema.parse(account.id)}`);
        if (existsSync(operations)) for (const name of readdirSync(operations).filter((name) => name.endsWith('.json'))) {
          const operation = readDocument(confined(operations, name), OperationSchema);
          if (operation.runtime !== runtime || operation.accountId !== account.id) throw failure('The saved Rigging operation belongs to another account.');
          if (operation.status === 'prepared') pending.push({ requestId: operation.requestId, itemId: operation.itemId, runtime, accountId: account.id, action: operation.action, fingerprint: operation.fingerprint, ref: operation.source.ref });
        }
        const captures = confined(this.homes.root, `rigging/promotions/${runtime}/${IdSchema.parse(account.id)}`);
        if (existsSync(captures)) for (const name of readdirSync(captures).filter((name) => name.endsWith('.json'))) {
          const promotion = readDocument(confined(captures, name), PromotionSchema);
          if (promotion.runtime !== runtime || promotion.accountId !== account.id) throw failure('The saved promotion belongs to another account.');
          if (promotion.status === 'prepared') promotions.push({ request: promotion.request, runtime, accountId: account.id, itemId: promotion.itemId, ref: promotion.source.ref, canCancel: !ownership.claims[promotion.entry.promotionId!] });
        }
      } catch (error) { report(error instanceof Error ? error.message : 'Could not inspect this account home.'); }
    }
    return RiggingDiskListSchema.parse({ schema: 'rigging-disk-list-v1', items, errors, pending, promotions });
  }
  #find(runtime: Runtime, accountId: string, id: string): RiggingDiskItem {
    const item = this.list([{ runtime, id: accountId }]).items.find((entry) => entry.id === id);
    if (!item) throw failure('Rigging item no longer exists. Refresh the list.', 404); return item;
  }
  #primary(item: RiggingDiskItem): string {
    const path = this.#path(item.runtime, item.accountId, item.address);
    return item.kind === 'skill' && lstatSync(path).isDirectory() ? confined(path, 'SKILL.md') : path;
  }
  detail(runtime: Runtime, accountId: string, id: string) {
    const item = this.#find(runtime, accountId, id); let content: string; let problem = item.problem;
    try {
      content = item.address.selector ? `${JSON.stringify(z.json().parse(get(config(this.#path(runtime, accountId, item.address), item.address.ref), item.address.selector)), null, 2)}\n` : text(this.#primary(item));
    } catch (error) { problem = error instanceof Error ? error.message : 'This content is not editable.'; content = ''; }
    const visible = this.redactor.text(content); const redacted = visible !== content;
    return RiggingDiskDetailSchema.parse({ schema: 'rigging-disk-detail-v1', item: { ...item, editable: item.editable && !redacted && !problem, ...(problem ? { problem } : {}) }, content: visible,
      format: item.address.selector ? 'json' : ['skill', 'rule', 'command'].includes(item.kind) ? 'markdown' : 'text', redacted });
  }
  async edit(runtime: Runtime, accountId: string, id: string, raw: unknown) {
    const input = RiggingDiskWriteSchema.parse(raw);
    return withRiggingHome(this.#home(runtime, accountId), () => {
      const detail = this.detail(runtime, accountId, id); const item = detail.item;
      if (item.fingerprint !== input.fingerprint) throw failure('This Rigging item changed. Reopen it before saving.');
      if (!item.editable) throw failure('Installed package content and redacted files are read-only.');
      if (this.redactor.text(input.content) !== input.content) throw failure('Store credentials in Accounts, not in Rigging content.', 400);
      const path = this.#primary(item); const mode = lstatSync(path).mode & 0o777;
      if (item.address.selector) {
        let value: z.infer<ReturnType<typeof z.json>>;
        try { value = z.json().parse(JSON.parse(input.content)); } catch { throw failure('Enter valid JSON for this configuration entry.', 400); }
        const current = config(path, item.address.ref);
        if (item.kind === 'mcp') object(value);
        if (item.kind === 'mcp' && item.address.ref === 'jevellan-mcp.json') McpRiggingSchema.parse(value);
        if (item.kind === 'hook') z.object({ hooks: z.array(z.json()) }).parse(value);
        atomicWrite(path, encode(change(current, item.address.selector, value), item.address.ref), mode);
      } else atomicWrite(path, input.content, mode);
      return this.detail(runtime, accountId, id);
    });
  }
  #promotionPath(runtime: Runtime, accountId: string, requestId: string) { return confined(this.homes.root, `rigging/promotions/${runtime}/${IdSchema.parse(accountId)}/${IdSchema.parse(requestId)}.json`); }
  async promote(runtime: Runtime, accountId: string, id: string, raw: unknown, store: SharedRigging) {
    const input = RiggingPromotionInputSchema.parse(raw);
    return withRiggingHome(this.#home(runtime, accountId), async () => {
      const path = this.#promotionPath(runtime, accountId, input.requestId);
      let promotion = existsSync(path) ? readDocument(path, PromotionSchema) : undefined;
      if (promotion && (promotion.itemId !== id || promotion.runtime !== runtime || promotion.accountId !== accountId || stableJson(promotion.request) !== stableJson(input))) throw failure('This promotion id was already used for another request.');
      if (!promotion) {
        const detail = this.detail(runtime, accountId, id); const item = detail.item;
        if (item.fingerprint !== input.fingerprint) throw failure('This Rigging item changed. Refresh it before making it managed.');
        if (item.state !== 'loose' || !item.editable || item.address.selector || !['skill', 'rule', 'command'].includes(item.kind)) throw failure('Only loose skills, rules and commands can become managed items. Restore parked items locally first.');
        if (!input.runtimes[runtime]) throw failure('Keep the source runtime selected when making this item managed.');
        const source = this.#path(runtime, accountId, item.address); const before = snapshot(source)!; const primary = this.#primary(item);
        const files = before.files.filter((file) => (before.directory ? confined(source, file.ref) : source) !== primary).map((file) => ({ ref: file.ref, base64: readFileSync(confined(source, file.ref)).toString('base64'), executable: Boolean(file.mode & 0o111) }));
        if (before.files.find((file) => (before.directory ? confined(source, file.ref) : source) === primary)?.hash !== hash(detail.content) || snapshot(source)?.hash !== before.hash || files.some((file) => hash(Buffer.from(file.base64, 'base64')) !== before.files.find((entry) => entry.ref === file.ref)?.hash)) throw failure('The source changed while it was being captured. Refresh it and try again.');
        const name = basename(item.address.ref).replace(/\.(?:instructions\.|prompt\.)?md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/g, '') || 'local-item';
        const promotionId = hash(stableJson({ runtime, accountId, id, requestId: input.requestId }));
        const entry = await store.validateCaptured({ schema: 'rigging-entry-v1', id: `rig_${promotionId.slice(0, 24)}`, promotionId, name: input.name, kind: item.kind, content: detail.content, runtimes: input.runtimes, state: 'owned', builtIn: false, bundle: { schema: 'rigging-bundle-v1', name, files }, updatedAt: new Date().toISOString() });
        promotion = writeDocument(path, PromotionSchema, { schema: 'rigging-promotion-v1', request: input, runtime, accountId, itemId: id, status: 'prepared', source: item.address, sourceHash: before.hash, files: Object.fromEntries(before.files.map((file) => [file.ref ? `${item.address.ref}/${file.ref}` : item.address.ref, file.hash])), entry });
      }
      if (promotion.status === 'cancelled') throw failure('This promotion was cancelled. Start a new request for the current item.');
      if (promotion.status === 'completed') return store.get(promotion.entry.id);
      await store.validateCaptured(promotion.entry);
      const promotionId = promotion.entry.promotionId!; const ownership = this.#ownership(runtime, accountId); const claim = ownership.claims[promotionId];
      if (claim && (claim.itemId !== promotion.entry.id || claim.sourceHash !== promotion.sourceHash || stableJson(claim.files) !== stableJson(promotion.files))) throw failure('The saved promotion claim does not match its captured files.');
      const statePath = confined(this.homes.root, `rigging/state/${runtime}/${IdSchema.parse(accountId)}.json`);
      if (!claim) {
        if (snapshot(this.#path(runtime, accountId, promotion.source))?.hash !== promotion.sourceHash || Object.keys(promotion.files).some((ref) => Object.hasOwn(ownership.files, ref))) throw failure('The source changed after this promotion was prepared. Keep the current files and start again.');
        ownership.claims[promotionId] = { schema: 'rigging-claim-v1', itemId: promotion.entry.id, sourceHash: promotion.sourceHash, files: promotion.files, pending: true };
        Object.assign(ownership.files, promotion.files); ownership.fingerprint = hash(stableJson(ownership));
        writeDocument(statePath, RiggingDeliveryStateSchema, ownership);
      }
      const result = await store.addCaptured(promotion.entry);
      ownership.claims[promotionId]!.pending = false;
      writeDocument(statePath, RiggingDeliveryStateSchema, ownership);
      writeDocument(path, PromotionSchema, { ...promotion, status: 'completed' });
      return result;
    });
  }
  async cancelPromotion(runtime: Runtime, accountId: string, id: string, raw: unknown) {
    const input = RiggingDiskCancelSchema.parse(raw);
    return withRiggingHome(this.#home(runtime, accountId), () => {
      const path = this.#promotionPath(runtime, accountId, input.requestId); const promotion = readDocument(path, PromotionSchema);
      if (promotion.runtime !== runtime || promotion.accountId !== accountId || promotion.itemId !== id) throw failure('This promotion belongs to another item.');
      if (promotion.status === 'completed' || this.#ownership(runtime, accountId).claims[promotion.entry.promotionId!]) throw failure('The captured item is already claimed. Retry to finish making it managed.');
      writeDocument(path, PromotionSchema, { ...promotion, status: 'cancelled' });
      return RiggingDiskCancelledSchema.parse({ schema: 'rigging-disk-cancelled-v1', requestId: input.requestId, status: 'cancelled' });
    });
  }
  #operationPath(runtime: Runtime, accountId: string, requestId: string) { return confined(this.homes.root, `rigging/operations/${runtime}/${IdSchema.parse(accountId)}/${IdSchema.parse(requestId)}.json`); }
  #prepare(item: RiggingDiskItem, input: z.infer<typeof RiggingDiskTransitionSchema>): Operation {
    if (item.fingerprint !== input.fingerprint) throw failure('This Rigging item changed. Refresh it before continuing.');
    if (input.action === 'park' ? !item.canPark : item.state !== 'parked') throw failure('This Rigging item cannot make that transition. Use its managed runtime toggles for installed items.');
    const source = item.address; let target: RiggingAddress = { ...source, ...(input.action === 'park' ? { bucket: `manual_${input.requestId}` } : { bucket: undefined }) };
    const sourcePath = this.#path(item.runtime, item.accountId, source); const targetPath = this.#path(item.runtime, item.accountId, target);
    const before = snapshot(sourcePath)!; const destination = snapshot(targetPath);
    for (const file of before.files) {
      const contents = readFileSync(before.directory ? confined(sourcePath, file.ref) : sourcePath, 'utf8');
      if (this.redactor.text(contents) !== contents) throw failure('This item contains credentials. Keep them in Accounts before moving the item.', 400);
    }
    let sourceAfter: string | null = null; let targetAfter = before.hash;
    if (!source.selector) { if (destination) throw failure('A Rigging item already exists at the destination. Nothing was replaced.'); }
    else {
      const original = config(sourcePath, source.ref); const contents = get(original, source.selector); let next = config(targetPath, target.ref); let selector = [...source.selector];
      if (typeof selector.at(-1) === 'number') {
        const prefix = selector.slice(0, -1); const siblings = has(next, prefix) ? z.array(z.unknown()).parse(get(next, prefix)) : [];
        if (siblings.some((entry) => stableJson(entry) === stableJson(contents))) throw failure('That hook already exists at the destination. Nothing was replaced.');
        selector = [...prefix, siblings.length];
      } else if (has(next, selector)) throw failure('That configuration entry already exists at the destination. Nothing was replaced.');
      target = { ...target, selector }; next = change(next, selector, contents);
      sourceAfter = fileHash(encode(change(original, source.selector, undefined, true), source.ref), before.files[0]!.mode);
      targetAfter = fileHash(encode(next, target.ref), destination?.files[0]?.mode ?? 0o600);
    }
    return OperationSchema.parse({ schema: 'rigging-disk-operation-v1', requestId: input.requestId, itemId: item.id, runtime: item.runtime, accountId: item.accountId, action: input.action, fingerprint: input.fingerprint,
      status: 'prepared', source, target, sourceBefore: before.hash, sourceAfter, targetBefore: destination?.hash ?? null, targetAfter });
  }
  #resume(operation: Operation): void {
    if (operation.status === 'completed') return;
    const source = this.#path(operation.runtime, operation.accountId, operation.source); const target = this.#path(operation.runtime, operation.accountId, operation.target);
    let before = snapshot(source); let destination = snapshot(target);
    if ((before?.hash ?? null) === operation.sourceAfter && destination?.hash === operation.targetAfter) return;
    if (before?.hash !== operation.sourceBefore) throw failure('The source changed during this operation. Its saved copy was preserved; refresh before continuing.');
    if (!operation.source.selector) {
      if (destination) throw failure('The destination changed. Nothing was replaced.');
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); renameSync(source, target); return;
    }
    const original = config(source, operation.source.ref); const contents = get(original, operation.source.selector);
    if ((destination?.hash ?? null) === operation.targetBefore) {
      const next = encode(change(config(target, operation.target.ref), operation.target.selector!, contents), operation.target.ref);
      const mode = destination?.files[0]?.mode ?? 0o600;
      if (fileHash(next, mode) !== operation.targetAfter) throw failure('The destination no longer matches the prepared operation.');
      atomicWrite(target, next, mode);
    } else if (destination?.hash !== operation.targetAfter) throw failure('The destination changed. Nothing was replaced.');
    before = snapshot(source); destination = snapshot(target);
    if (before?.hash !== operation.sourceBefore || destination?.hash !== operation.targetAfter) throw failure('Rigging changed while preserving the selected entry. Both copies were retained.');
    const next = encode(change(original, operation.source.selector, undefined, true), operation.source.ref);
    if (fileHash(next, before.files[0]!.mode) !== operation.sourceAfter) throw failure('The source no longer matches the prepared operation.');
    atomicWrite(source, next, before.files[0]!.mode);
  }
  async transition(runtime: Runtime, accountId: string, id: string, raw: unknown) {
    const input = RiggingDiskTransitionSchema.parse(raw);
    return withRiggingHome(this.#home(runtime, accountId), () => {
      const path = this.#operationPath(runtime, accountId, input.requestId);
      let operation = existsSync(path) ? readDocument(path, OperationSchema) : undefined;
      if (operation && (operation.itemId !== id || operation.runtime !== runtime || operation.accountId !== accountId || operation.action !== input.action || operation.fingerprint !== input.fingerprint)) throw failure('This operation id was already used for another request.');
      operation ??= writeDocument(path, OperationSchema, this.#prepare(this.#find(runtime, accountId, id), input));
      if (operation.status === 'cancelled') throw failure('This operation was cancelled. Start a new request for the current item.');
      this.#resume(operation); writeDocument(path, OperationSchema, { ...operation, status: 'completed' });
      return RiggingDiskResultSchema.parse({ schema: 'rigging-disk-result-v1', requestId: input.requestId, status: 'completed' });
    });
  }
  async cancel(runtime: Runtime, accountId: string, id: string, raw: unknown) {
    const input = RiggingDiskCancelSchema.parse(raw);
    return withRiggingHome(this.#home(runtime, accountId), () => {
      const path = this.#operationPath(runtime, accountId, input.requestId); const operation = readDocument(path, OperationSchema);
      if (operation.runtime !== runtime || operation.accountId !== accountId || operation.itemId !== id) throw failure('This operation belongs to another item.');
      if (operation.status === 'completed') throw failure('This operation already finished.');
      writeDocument(path, OperationSchema, { ...operation, status: 'cancelled' });
      return RiggingDiskCancelledSchema.parse({ schema: 'rigging-disk-cancelled-v1', requestId: input.requestId, status: 'cancelled' });
    });
  }
}
