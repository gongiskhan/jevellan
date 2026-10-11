import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { readDocument } from './files.js';
import type { Homes } from './homes.js';
import { DeviceConfigSchema, DeviceWorkPolicySchema, IdSchema, RelativePathSchema, TimestampSchema } from './schemas.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const HubArchiveHeaderSchema = z.strictObject({
  schema: z.literal('hub-archive-v1'), cipher: z.literal('aes-256-gcm'), kdf: z.literal('scrypt-32768-8-1'),
  salt: z.base64().refine(value => Buffer.from(value, 'base64').length === 16),
  nonce: z.base64().refine(value => Buffer.from(value, 'base64').length === 12),
});
export const HubExportManifestSchema = z.strictObject({
  schema: z.literal('hub-export-manifest-v1'), id: IdSchema, createdAt: TimestampSchema,
  sourceHome: z.string().refine(isAbsolute), sourceDevice: DeviceConfigSchema,
  destinationName: z.string().trim().min(1).max(128),
  entries: z.array(z.strictObject({ path: RelativePathSchema, bytes: z.number().int().nonnegative(),
    mode: z.number().int().min(0).max(0o777).refine(mode => (mode & ~0o111) === 0o600), sha256: digest })).max(100_000),
  excluded: z.array(z.strictObject({ path: RelativePathSchema, reason: z.string().min(1).max(200) })).max(100_000),
});
export type HubExportManifest = z.infer<typeof HubExportManifestSchema>;
export const HubMovedSchema = z.strictObject({
  schema: z.literal('hub-moved-v1'), exportId: IdSchema, destinationName: z.string().min(1).max(128),
  exportedAt: TimestampSchema, archiveSha256: digest,
});
export const HubImportReceiptSchema = z.strictObject({
  schema: z.literal('hub-import-receipt-v1'), exportId: IdSchema, importedAt: TimestampSchema,
  sourceDeviceId: IdSchema, destinationDeviceId: IdSchema, archiveSha256: digest,
  unboundProjectIds: z.array(IdSchema), needsLoginAccountIds: z.array(IdSchema),
});
export type HubImportReceipt = z.infer<typeof HubImportReceiptSchema>;
export const HubPathMapSchema = z.strictObject({ schema: z.literal('hub-path-map-v1'), paths: z.record(IdSchema, z.string().refine(isAbsolute)) });
export const HubImportActivationSchema = z.strictObject({
  schema: z.literal('hub-import-activation-v1'), exportId: IdSchema,
  home: z.string().refine(isAbsolute), stage: z.string().refine(isAbsolute), backup: z.string().refine(isAbsolute),
});
export function deviceAllowsWork(homes: Homes): boolean {
  const file = homes.at('device-work-policy.json');
  return !existsSync(file) || readDocument(file, DeviceWorkPolicySchema).mode === 'work';
}
export function assertHubNotMoved(homes: Homes, force = false): void {
  if (existsSync(`${homes.root}.import-operation.json`)) throw new Error('A hub import is pending. Finish or recover it before starting Jevellan.');
  const file = homes.at('hub-moved.json');
  if (!existsSync(file) || force) return;
  const moved = readDocument(file, HubMovedSchema);
  throw new Error(`This hub moved to ${moved.destinationName}. Run jevellan hub import there, or start with --force to keep using this copy.`);
}
