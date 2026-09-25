import { z } from 'zod';
import { AccountSchema, AccountStatusSchema, ConfigRevisionSchema, IdSchema, TimestampSchema, type Account, type AccountStatus } from './schemas.js';
import { AccountListSchema, AccountViewSchema, AddAccountSchema, CredentialInputSchema, OfferedModelsSchema, UpdateAccountSchema, type AccountView } from './client-schemas.js';

export const AccountUseSchema = z.strictObject({ schema: z.literal('account-use-v1'), accountId: IdSchema, deviceId: IdSchema, at: TimestampSchema });
export const AccountModelsResultSchema = z.strictObject({ schema: z.literal('account-models-result-v1'), offered: OfferedModelsSchema, configuration: ConfigRevisionSchema.nullable() });
export const OfferedModelsListSchema = z.strictObject({ schema: z.literal('offered-models-list-v1'), offered: z.array(OfferedModelsSchema) });
export const RecentAccountsSchema = z.strictObject({ schema: z.literal('recent-accounts-v1'), accountIds: z.array(IdSchema) });
export const AccountWriteResultSchema = z.strictObject({ schema: z.literal('account-write-result-v1'), applied: z.literal(true) });
export const AccountCredentialSchema = z.strictObject({ schema: z.literal('account-credential-v1'), accountId: IdSchema, secretRef: IdSchema, value: CredentialInputSchema });
export const CredentialCaptureReceiptSchema = z.strictObject({
  schema: z.literal('credential-capture-receipt-v1'), requestId: IdSchema, deviceId: IdSchema, accountId: IdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), secretRef: IdSchema,
});
const base = { schema: z.literal('account-hub-request-v1') };
export const AccountHubRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('get'), id: IdSchema }),
  z.strictObject({ ...base, operation: z.literal('list') }),
  z.strictObject({ ...base, operation: z.literal('add'), input: AddAccountSchema }),
  z.strictObject({ ...base, operation: z.literal('update'), id: IdSchema, input: UpdateAccountSchema }),
  z.strictObject({ ...base, operation: z.literal('status'), id: IdSchema }),
  z.strictObject({ ...base, operation: z.literal('write-status'), status: AccountStatusSchema, credential: IdSchema.nullable(), identity: AccountSchema.shape.identity }),
  z.strictObject({ ...base, operation: z.literal('capture'), id: IdSchema, revision: z.number().int().positive(), secret: CredentialInputSchema, requestId: IdSchema.optional() }),
  z.strictObject({ ...base, operation: z.literal('credential'), id: IdSchema, secretRef: IdSchema }),
  z.strictObject({ ...base, operation: z.literal('models') }),
  z.strictObject({ ...base, operation: z.literal('record-models'), id: IdSchema, models: OfferedModelsSchema.shape.models }),
  z.strictObject({ ...base, operation: z.literal('mark-used'), id: IdSchema }),
  z.strictObject({ ...base, operation: z.literal('recent') }),
]);
export type AccountHubRequest = z.infer<typeof AccountHubRequestSchema>;
export const AccountHubResultSchema = z.union([AccountViewSchema, AccountListSchema, AccountStatusSchema, AccountModelsResultSchema, OfferedModelsListSchema, RecentAccountsSchema, AccountWriteResultSchema, AccountCredentialSchema]);
type Available<T> = T | Promise<T>;
/** Shared account data and credentials; implementations bind every operation to one device. */
export interface AccountStore {
  get(id: string): Available<AccountView>;
  list(): Available<AccountView[]>;
  add(input: unknown): Available<AccountView>;
  update(id: string, input: unknown): Available<AccountView>;
  status(id: string): Available<AccountStatus>;
  writeStatus(status: AccountStatus, credential: string | null, identity?: Account['identity']): Available<AccountStatus>;
  capture(id: string, revision: number, secret: string, requestId?: string): Available<AccountView>;
  credential(id: string, secretRef: string): Available<string>;
  models(): Available<z.infer<typeof OfferedModelsSchema>[]>;
  recordModels(id: string, models: z.infer<typeof OfferedModelsSchema>['models']): Available<z.infer<typeof AccountModelsResultSchema>>;
  markUsed(id: string): Available<void>;
  recent(): Available<string[]>;
}
