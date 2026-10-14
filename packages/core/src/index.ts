import { z } from 'zod';

export const DEFAULT_PORT = 9771;
export const VERSION = '0.3.3';
export const HealthSchema = z.object({
  schema: z.literal('health-v1'),
  status: z.literal('ok'),
  version: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;
export * from './schemas.js';
export * from './session-cache-schemas.js';
export * from './improver-schemas.js';
export * from './project-improver-schemas.js';
export * from './text-diff.js';
export * from './routing-fields.js';
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
export * from './git-settings-schemas.js';
export * from './git-settings.js';
export * from './cursor-schemas.js';
export * from './session-list-schemas.js';
export * from './project-schemas.js';
export * from './project-hub-schemas.js';
export * from './project-hub.js';
export * from './project-rules.js';
export * from './github.js';
export * from './agent-access-schemas.js';
export * from './hub-migration-schemas.js';

export * from './native-setup.js';
export * from './project-instructions.js';
export * from './native-setup-schemas.js';
export * from './project-loop-schemas.js';

export * from './project-goal-schemas.js';

export * from './project-daily-schemas.js';

export * from './github-actions.js';
export * from './task-types.js';
export * from './effort-guide.js';

export * from './ekoa-schemas.js';

export * from './merge-schemas.js';

export * from './project-review-schemas.js';
export * from './workflow-schemas.js';
export * from './ekoa-code-schemas.js';
export * from './device-facts.js';
export * from './worktree-disk-schemas.js';
export * from './github-awareness-schemas.js';
export * from './project-memory-schemas.js';
export * from './owner-command-schemas.js';
export * from './project-memory-session-schemas.js';
export * from './terminal-schemas.js';
