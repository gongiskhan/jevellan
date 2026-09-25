import { createHash, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { CheckoutClaimSchema, IdSchema, PublicationLeaseSchema, type CheckoutClaim, type DocumentSchema, type Project, type PublicationLease } from './schemas.js';
import { readDocument, writeDocument } from './files.js';
import { Homes, resolveProjectPath } from './homes.js';
import type { Stored } from './store.js';

export interface CoordinationStore {
  get<T>(namespace: string, id: string, schema: DocumentSchema<T>): Stored<T> | null | Promise<Stored<T> | null>;
  put<T>(namespace: string, id: string, schema: DocumentSchema<T>, value: unknown, expectedRevision: number): Stored<T> | Promise<Stored<T>>;
}
export type CheckoutOwner = { conversationId: string; conversationTitle: string; workId: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sameOwner = (a: CheckoutOwner, b: CheckoutOwner) => a.conversationId === b.conversationId && a.workId === b.workId;

export class CheckoutOwnership {
  constructor(readonly hub: CoordinationStore, readonly homes: Homes, readonly deviceId: string, readonly pid = process.pid) { IdSchema.parse(deviceId); }
  #key(path: string): string { return digest(`${this.deviceId}\0${path}`); }
  #file(path: string): string { return this.homes.at('locks', `${createHash('sha1').update(path).digest('hex')}.json`); }
  async current(project: Project): Promise<CheckoutClaim | null> {
    const path = resolveProjectPath(project, this.deviceId);
    return (await this.hub.get('checkout-ownership', this.#key(path), CheckoutClaimSchema))?.document ?? null;
  }
  async acquire(project: Project, owner: CheckoutOwner): Promise<CheckoutClaim> {
    const path = resolveProjectPath(project, this.deviceId); const key = this.#key(path);
    const previous = await this.hub.get('checkout-ownership', key, CheckoutClaimSchema);
    if (previous?.document.held && !sameOwner(previous.document, owner)) throw new Error(`${project.name} on ${this.deviceId} is in use by "${previous.document.conversationTitle}".`);
    if (previous?.document.held && previous.document.pid !== this.pid) {
      try { process.kill(previous.document.pid, 0); throw new Error('The previous checkout owner process is still alive.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    const file = this.#file(path);
    if (existsSync(file)) {
      const local = readDocument(file, CheckoutClaimSchema);
      if (local.path !== path || local.deviceId !== this.deviceId) throw new Error('Checkout lock belongs to another path or device.');
      if (!previous || !sameOwner(local, previous.document) || local.pid !== previous.document.pid) throw new Error('Local checkout ownership differs from the hub; recover it before writing.');
      // A release can reach the hub and then crash before deleting its local file.
      if (!previous.document.held) unlinkSync(file);
    }
    return this.#record(path, key, owner, previous?.revision ?? 0);
  }
  async #record(path: string, key: string, owner: CheckoutOwner, revision: number): Promise<CheckoutClaim> {
    const claim = CheckoutClaimSchema.parse({ schema: 'checkout-claim-v1', deviceId: this.deviceId, path, ...owner, held: true, pid: this.pid, updatedAt: new Date().toISOString() });
    const saved = await this.hub.put('checkout-ownership', key, CheckoutClaimSchema, claim, revision);
    writeDocument(this.#file(path), CheckoutClaimSchema, saved.document);
    return saved.document;
  }
  /** A recorded undo can move ownership within its conversation without freeing it. */
  async transfer(project: Project, from: CheckoutOwner, to: CheckoutOwner, processesGone: boolean): Promise<CheckoutClaim> {
    if (!processesGone) throw new Error('Checkout ownership cannot transfer before process termination.');
    if (from.conversationId !== to.conversationId || from.workId === to.workId) throw new Error('Checkout transfer requires two works of the same conversation.');
    const path = resolveProjectPath(project, this.deviceId); const key = this.#key(path);
    const previous = await this.hub.get('checkout-ownership', key, CheckoutClaimSchema);
    if (!previous?.document.held || ![from, to].some((owner) => sameOwner(owner, previous.document))) throw new Error('Another work owns this checkout.');
    const local = readDocument(this.#file(path), CheckoutClaimSchema);
    const moving = sameOwner(previous.document, from);
    if (!local.held || local.path !== path || local.deviceId !== this.deviceId || !(sameOwner(local, from) || !moving && sameOwner(local, to))) throw new Error('Local checkout ownership does not match the recorded transfer.');
    // A hub update can survive a crash before the local file. Only this exact
    // same-conversation transfer may reconcile that pair of owners.
    for (const pid of new Set([previous.document.pid, local.pid])) if (pid !== this.pid) {
      try { process.kill(pid, 0); throw new Error('The previous checkout owner process is still alive.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    return this.#record(path, key, to, previous.revision);
  }
  async assert(project: Project, owner: CheckoutOwner): Promise<CheckoutClaim> {
    const path = resolveProjectPath(project, this.deviceId);
    const held = await this.hub.get('checkout-ownership', this.#key(path), CheckoutClaimSchema);
    if (!held?.document.held || !sameOwner(held.document, owner) || held.document.pid !== this.pid) throw new Error('This work does not own the checkout.');
    const local = readDocument(this.#file(path), CheckoutClaimSchema);
    if (!local.held || !sameOwner(local, owner) || local.pid !== this.pid || local.path !== path || local.deviceId !== this.deviceId) throw new Error('Local checkout ownership is missing or changed.');
    return held.document;
  }
  async release(project: Project, owner: CheckoutOwner, settled: { processesGone: boolean; commits: 'published' | 'discarded' | 'unchanged' | 'kept' | 'unsettled' }): Promise<void> {
    if (!settled.processesGone) throw new Error('Checkout ownership stays held until runtime termination is confirmed.');
    if (settled.commits === 'kept' || settled.commits === 'unsettled') throw new Error('Unpublished work keeps checkout ownership.');
    const path = resolveProjectPath(project, this.deviceId); const observed = await this.hub.get('checkout-ownership', this.#key(path), CheckoutClaimSchema);
    // A release reply can be lost after the hub commits. Reconcile only this
    // exact released owner; a newer owner must never be cleared by the retry.
    if (observed && !observed.document.held && sameOwner(observed.document, owner) && observed.document.pid === this.pid) {
      const file = this.#file(path);
      if (existsSync(file)) {
        const local = readDocument(file, CheckoutClaimSchema);
        if (local.path !== path || local.deviceId !== this.deviceId || !sameOwner(local, owner) || local.pid !== this.pid) throw new Error('Local checkout ownership differs from the released hub claim.');
        unlinkSync(file);
      }
      return;
    }
    const claim = await this.assert(project, owner); const key = this.#key(claim.path);
    const previous = await this.hub.get('checkout-ownership', key, CheckoutClaimSchema);
    if (!previous?.document.held || !sameOwner(previous.document, owner) || previous.document.pid !== this.pid) throw new Error('Checkout ownership changed before release.');
    await this.hub.put('checkout-ownership', key, CheckoutClaimSchema, { ...claim, held: false, updatedAt: new Date().toISOString() }, previous.revision);
    const file = this.#file(claim.path);
    if (existsSync(file)) {
      const local = readDocument(file, CheckoutClaimSchema);
      if (sameOwner(local, owner) && local.pid === this.pid) unlinkSync(file);
    }
  }
}

export const PUBLICATION_LEASE_MS = 120_000;
export const PUBLICATION_RENEW_MS = 30_000;
/** Run on the hub. Member devices call its HTTP endpoints so one clock governs leases. */
export class PublicationLeases {
  constructor(readonly hub: CoordinationStore, readonly now = Date.now) {}
  async acquire(remote: string, owner: string): Promise<PublicationLease> {
    const key = digest(remote); const current = await this.hub.get('publication-leases', key, PublicationLeaseSchema);
    if (current?.document.held && Date.parse(current.document.expiresAt) > this.now()) {
      if (current.document.owner === owner) return current.document;
      throw new Error('Another work is publishing to this remote.');
    }
    const lease = PublicationLeaseSchema.parse({ schema: 'publication-lease-v1', remote, owner, token: `lease_${randomUUID()}`, held: true, expiresAt: new Date(this.now() + PUBLICATION_LEASE_MS).toISOString() });
    return (await this.hub.put('publication-leases', key, PublicationLeaseSchema, lease, current?.revision ?? 0)).document;
  }
  async #current(lease: PublicationLease): Promise<Stored<PublicationLease>> {
    const current = await this.hub.get('publication-leases', digest(lease.remote), PublicationLeaseSchema);
    if (!current?.document.held || current.document.token !== lease.token || current.document.owner !== lease.owner || Date.parse(current.document.expiresAt) <= this.now()) throw new Error('Publication lease was lost. Stop before pushing.');
    return current;
  }
  async assert(lease: PublicationLease): Promise<void> { await this.#current(lease); }
  async renew(lease: PublicationLease): Promise<PublicationLease> {
    const current = await this.#current(lease);
    return (await this.hub.put('publication-leases', digest(lease.remote), PublicationLeaseSchema, { ...current.document, expiresAt: new Date(this.now() + PUBLICATION_LEASE_MS).toISOString() }, current.revision)).document;
  }
  async release(lease: PublicationLease): Promise<void> {
    const current = await this.hub.get('publication-leases', digest(lease.remote), PublicationLeaseSchema);
    if (!current || current.document.token !== lease.token || current.document.owner !== lease.owner) throw new Error('Publication lease was lost. Stop before pushing.');
    if (!current.document.held) return;
    await this.hub.put('publication-leases', digest(lease.remote), PublicationLeaseSchema, { ...current.document, held: false }, current.revision);
  }
}

export type PublicationLeaseService = Pick<PublicationLeases, 'acquire' | 'renew' | 'assert' | 'release'>;

export async function withPublicationLease<T>(leases: PublicationLeaseService, remote: string, owner: string, publish: (assertLease: () => Promise<void>) => Promise<T>, intervalMs = PUBLICATION_RENEW_MS): Promise<T> {
  let lease = await leases.acquire(remote, owner); let lost = false; let lostReason: unknown; let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || lost) return;
    pending = leases.renew(lease).then((renewed) => { lease = renewed; }).catch(error => { lost = true; lostReason = error; }).finally(() => { pending = undefined; });
  }, intervalMs);
  const assertLease = async () => {
    await pending;
    if (lost) throw lostReason ?? new Error('Publication lease renewal failed. Stop before pushing.');
    try { await leases.assert(lease); } catch (error) { lost = true; lostReason = error; throw error; }
  };
  try { return await publish(assertLease); }
  finally {
    clearInterval(timer); await pending;
    if (!lost) await leases.release(lease);
  }
}
