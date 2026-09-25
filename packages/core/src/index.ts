import { z } from 'zod';

export const DEFAULT_PORT = 9771;
export const VERSION = '0.1.0';
export const HealthSchema = z.object({
  schema: z.literal('health-v1'),
  status: z.literal('ok'),
  version: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;
export * from './schemas.js';
export * from './hub-errors.js';
export * from './composer-schemas.js';
export * from './mesh-schemas.js';
export * from './actions.js';
export * from './homes.js';
export * from './app-paths.js';
export * from './files.js';
export * from './environment.js';
export * from './configuration.js';
export * from './vault.js';
export * from './models.js';
export * from './rigging.js';
export * from './store.js';
export * from './account-store.js';
export * from './locks.js';
export * from './coordination-schemas.js';
export * from './index-store.js';
export * from './shared-state.js';
export * from './process-group.js';
export * from './command.js';
export * from './git.js';
export * from './git-rewrite.js';
export * from './daemon-ownership.js';
export * from './lifecycle.js';
export * from './diagnostics.js';
export * from './rigging-store.js';
export * from './project-memory-rigging.js';
export * from './project-visibility.js';
export * from './rigging-disk-schemas.js';
export * from './rigging-bundle-schemas.js';
export * from './rigging-disk.js';
export * from './client-schemas.js';
export * from './bridge-schemas.js';
export * from './context-schemas.js';
export * from './conversation-schemas.js';
