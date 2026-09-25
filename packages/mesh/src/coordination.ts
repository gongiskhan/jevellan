import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { CheckoutClaimSchema, CheckoutStoreRequestSchema, CheckoutStoreResultSchema, IdSchema, PublicationLeases, PublicationLeaseRequestSchema, PublicationLeaseResultSchema, PublicationLeaseSchema, type CheckoutClaim, type CoordinationStore, type DocumentSchema, type PublicationLease, type PublicationLeaseService } from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { HubProtocolError, type MemberHubClient } from './client.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const checkoutKey = (claim: CheckoutClaim) => hash(`${claim.deviceId}\0${claim.path}`);
function checkoutNamespace(namespace: string) { if (namespace !== 'checkout-ownership') throw new Error('Use the checkout ownership store only for checkout claims.'); }
function refuse(message: string, status = 403): never { throw Object.assign(new Error(message), { status }); }

/** Bind shared checkout records to the requesting device; local files stay local. */
export class HubCheckoutStore implements CoordinationStore {
  constructor(readonly hub: HubDatabase, readonly deviceId: string, private readonly now = Date.now) { IdSchema.parse(deviceId); }
  #claim(id: string, claim: CheckoutClaim): void {
    if (claim.deviceId !== this.deviceId || checkoutKey(claim) !== id || !(posix.isAbsolute(claim.path) || win32.isAbsolute(claim.path))) refuse('Checkout ownership belongs to another device or path.');
  }
  get<T>(namespace: string, id: string, schema: DocumentSchema<T>) {
    checkoutNamespace(namespace); const row = this.hub.get(namespace, id, CheckoutClaimSchema);
    if (!row) return null;
    this.#claim(id, row.document); return { revision: row.revision, document: schema.parse(row.document) };
  }
  put<T>(namespace: string, id: string, schema: DocumentSchema<T>, value: unknown, expectedRevision: number) {
    checkoutNamespace(namespace); const claim = CheckoutClaimSchema.parse(value); this.#claim(id, claim);
    return this.hub.transaction(() => {
      const previous = this.get(namespace, id, CheckoutClaimSchema);
      if (previous?.document.held && (previous.document.conversationId !== claim.conversationId || !claim.held && previous.document.workId !== claim.workId)) refuse('Another work owns this checkout.', 409);
      const saved = this.hub.put(namespace, id, CheckoutClaimSchema, { ...claim, updatedAt: new Date(this.now()).toISOString() }, expectedRevision);
      return { revision: saved.revision, document: schema.parse(saved.document) };
    });
  }
  request(input: unknown) {
    const request = CheckoutStoreRequestSchema.parse(input);
    const row = request.operation === 'get' ? this.get('checkout-ownership', request.id, CheckoutClaimSchema)
      : this.put('checkout-ownership', request.id, CheckoutClaimSchema, request.claim, request.expectedRevision);
    return CheckoutStoreResultSchema.parse({ schema: 'checkout-store-result-v1', id: request.id, row });
  }
}

export class MemberCheckoutStore implements CoordinationStore {
  constructor(readonly client: MemberHubClient) {}
  #row<T>(id: string, result: ReturnType<typeof CheckoutStoreResultSchema.parse>, schema: DocumentSchema<T>) {
    if (result.id !== id || result.row && (result.row.document.deviceId !== this.client.deviceId || checkoutKey(result.row.document) !== id)) throw new HubProtocolError();
    return result.row ? { revision: result.row.revision, document: schema.parse(result.row.document) } : null;
  }
  async get<T>(namespace: string, id: string, schema: DocumentSchema<T>) {
    checkoutNamespace(namespace);
    return this.#row(id, await this.client.checkout({ schema: 'checkout-store-request-v1', operation: 'get', id }), schema);
  }
  async put<T>(namespace: string, id: string, schema: DocumentSchema<T>, value: unknown, expectedRevision: number) {
    checkoutNamespace(namespace); const claim = CheckoutClaimSchema.parse(value);
    const row = this.#row(id, await this.client.checkout({ schema: 'checkout-store-request-v1', operation: 'put', id, claim, expectedRevision }), schema);
    if (!row) throw new HubProtocolError(); return row;
  }
}

/** The hub's clock and device-scoped owner govern every publication operation. */
export class HubPublicationLeases implements PublicationLeaseService {
  readonly #leases: PublicationLeases;
  constructor(readonly hub: HubDatabase, readonly deviceId: string, now = Date.now) { IdSchema.parse(deviceId); this.#leases = new PublicationLeases(hub, now); }
  #owner(owner: string) { return hash(`${this.deviceId}\0${IdSchema.parse(owner)}`); }
  #scoped(input: PublicationLease) { const lease = PublicationLeaseSchema.parse(input); return { ...lease, owner: this.#owner(lease.owner) }; }
  async acquire(remote: string, owner: string) {
    const lease = await this.#leases.acquire(PublicationLeaseSchema.shape.remote.parse(remote), this.#owner(owner));
    return { ...lease, owner };
  }
  async renew(lease: PublicationLease) { return { ...await this.#leases.renew(this.#scoped(lease)), owner: lease.owner }; }
  assert(lease: PublicationLease) { return this.#leases.assert(this.#scoped(lease)); }
  release(lease: PublicationLease) { return this.#leases.release(this.#scoped(lease)); }
  async request(input: unknown) {
    const request = PublicationLeaseRequestSchema.parse(input); let lease: PublicationLease | null = null;
    if (request.operation === 'acquire') lease = await this.acquire(request.remote, request.owner);
    else if (request.operation === 'renew') lease = await this.renew(request.lease);
    else if (request.operation === 'assert') await this.assert(request.lease);
    else await this.release(request.lease);
    return PublicationLeaseResultSchema.parse({ schema: 'publication-lease-result-v1', lease });
  }
}

export class MemberPublicationLeases implements PublicationLeaseService {
  constructor(readonly client: MemberHubClient) {}
  async acquire(remote: string, owner: string) {
    const result = await this.client.publication({ schema: 'publication-lease-request-v1', operation: 'acquire', remote, owner });
    if (!result.lease?.held || result.lease.remote !== remote || result.lease.owner !== owner) throw new HubProtocolError(); return result.lease;
  }
  async renew(lease: PublicationLease) {
    const result = await this.client.publication({ schema: 'publication-lease-request-v1', operation: 'renew', lease });
    if (!result.lease?.held || result.lease.remote !== lease.remote || result.lease.owner !== lease.owner || result.lease.token !== lease.token) throw new HubProtocolError(); return result.lease;
  }
  async assert(lease: PublicationLease) {
    if ((await this.client.publication({ schema: 'publication-lease-request-v1', operation: 'assert', lease })).lease !== null) throw new HubProtocolError();
  }
  async release(lease: PublicationLease) {
    if ((await this.client.publication({ schema: 'publication-lease-request-v1', operation: 'release', lease })).lease !== null) throw new HubProtocolError();
  }
}
