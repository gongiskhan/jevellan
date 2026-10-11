import { z } from 'zod';
export const NativeSetupInventorySchema = z.strictObject({ schema: z.literal('native-setup-inventory-v1'),
  runtime: z.enum(['claude', 'codex']), enabled: z.boolean(), items: z.array(z.strictObject({
    path: z.string(), item: z.string(), mechanism: z.enum(['prompt', 'launch', 'copy', 'none']),
    applied: z.boolean(), reason: z.string().optional(),
  })) });
export type NativeSetupInventory = z.infer<typeof NativeSetupInventorySchema>;
export const NativeLaunchSetupSchema = z.strictObject({ schema: z.literal('native-launch-setup-v1'),
  instructions: z.string(), generation: z.string().optional(), userHome: z.string().optional(), hooks: z.array(z.strictObject({ matcher: z.string(), commands: z.array(z.string()) })).optional(), settings: z.record(z.string(), z.json()), plugins: z.array(z.string()),
});
export type NativeLaunchSetup = z.infer<typeof NativeLaunchSetupSchema>;
