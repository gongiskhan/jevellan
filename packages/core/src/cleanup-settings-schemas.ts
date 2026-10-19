import { z } from 'zod';
const retention = z.strictObject({ days: z.number().int().min(0).max(3650), maxGb: z.number().min(0).max(10000) });
export const CleanupSettingsSchema = z.strictObject({ schema: z.literal('cleanup-settings-v1'),
  logs: retention.default({ days: 14, maxGb: 5 }), evidence: retention.default({ days: 30, maxGb: 10 }),
  worktrees: retention.default({ days: 3, maxGb: 20 }), workspaces: retention.default({ days: 2, maxGb: 20 }),
  freeDiskFloorGb: z.number().min(0).max(100000).default(50) });
export type CleanupSettings = z.infer<typeof CleanupSettingsSchema>;
export const defaultCleanupSettings = (): CleanupSettings => CleanupSettingsSchema.parse({ schema: 'cleanup-settings-v1' });
