import { z } from 'zod';
import { CheckoutClaimSchema, IdSchema, PublicationLeaseSchema } from './schemas.js';

const checkoutKey = z.string().regex(/^[a-f0-9]{64}$/);
const checkoutBase = { schema: z.literal('checkout-store-request-v1'), id: checkoutKey };
export const CheckoutStoreRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...checkoutBase, operation: z.literal('get') }),
  z.strictObject({ ...checkoutBase, operation: z.literal('put'), claim: CheckoutClaimSchema, expectedRevision: z.number().int().nonnegative() }),
]);
export const CheckoutStoreResultSchema = z.strictObject({
  schema: z.literal('checkout-store-result-v1'), id: checkoutKey,
  row: z.strictObject({ revision: z.number().int().positive(), document: CheckoutClaimSchema }).nullable(),
});
const publicationBase = { schema: z.literal('publication-lease-request-v1') };
export const PublicationLeaseRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...publicationBase, operation: z.literal('acquire'), remote: PublicationLeaseSchema.shape.remote, owner: IdSchema }),
  z.strictObject({ ...publicationBase, operation: z.literal('renew'), lease: PublicationLeaseSchema }),
  z.strictObject({ ...publicationBase, operation: z.literal('assert'), lease: PublicationLeaseSchema }),
  z.strictObject({ ...publicationBase, operation: z.literal('release'), lease: PublicationLeaseSchema }),
]);
export const PublicationLeaseResultSchema = z.strictObject({ schema: z.literal('publication-lease-result-v1'), lease: PublicationLeaseSchema.nullable() });
