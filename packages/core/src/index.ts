import { z } from 'zod';

export const DEFAULT_PORT = 9771;
export const VERSION = '0.1.0';
export const HealthSchema = z.object({
  schema: z.literal('health-v1'),
  status: z.literal('ok'),
  version: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;
