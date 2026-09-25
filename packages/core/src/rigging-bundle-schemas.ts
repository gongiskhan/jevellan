import { z } from 'zod';

const relativeFile = z.string().min(1).max(512).refine((value) => !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Expected a relative bundle file.');
export const RiggingBundleSchema = z.strictObject({
  schema: z.literal('rigging-bundle-v1'), name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  files: z.array(z.strictObject({ ref: relativeFile, base64: z.string().max(14 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), executable: z.boolean() })).max(255),
}).refine(({ files }) => new Set(files.map((file) => file.ref)).size === files.length && files.every((file) => file.ref !== 'SKILL.md' && !files.some((other) => other.ref.startsWith(`${file.ref}/`))) && files.reduce((sum, file) => sum + file.base64.length, 0) <= 14 * 1024 * 1024, 'Invalid or oversized bundle.');
export const RiggingBundleSummarySchema = z.strictObject({ schema: z.literal('rigging-bundle-summary-v1'), name: z.string(), fileCount: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
