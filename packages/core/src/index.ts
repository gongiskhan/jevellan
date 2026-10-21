import { z } from 'zod';

export const DEFAULT_PORT = 9771;
export const VERSION = '0.7.2';
export const HealthSchema = z.object({
  schema: z.literal('health-v1'),
  status: z.literal('ok'),
  version: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;
export * from './schemas.js';
export * from './reply.js';
export * from './owner-tool-schemas.js';
export * from './owner-tool-catalog.js';
export * from './owner-time.js';
export * from './version-skew.js';
export * from './session-cache-schemas.js';
export * from './project-journal-schemas.js';
export * from './improver-schemas.js';
export * from './improver-presentation-schemas.js';
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
export * from './decisions-settings-schemas.js';
export * from './decisions-settings.js';
export * from './rigging.js';
export * from './store.js';
export * from './account-store.js';
export * from './account-status.js';
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
export * from './project-configuration-schemas.js';
export * from './project-coordinator-editor-schemas.js';
export * from './project-settings-change-view-schemas.js';
export * from './project-landing-editor-schemas.js';
export * from './project-settings-editor-schemas.js';
export * from './project-page-schemas.js';
export * from './project-card-schemas.js';
export * from './project-waiting-schemas.js';
export * from './project-waiting-response-schemas.js';
export * from './project-view-notice-schemas.js';
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
export * from './project-goal-view-schemas.js';
export * from './project-thread-why-schemas.js';
export * from './project-override-editor-schemas.js';
export * from './project-route-why-schemas.js';

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

export * from './checkpoint-schemas.js';
export * from './vault-schemas.js';

export * from './project-parity-schemas.js';
export * from './project-usage-schemas.js';

export * from './project-setting-values.js';

export * from './notification-schemas.js';
export * from './library-schemas.js';

export * from './project-setup-schemas.js';

export * from './project-health-schemas.js';

export * from './project-landing-schemas.js';

export * from './project-deploy-schemas.js';
export * from './project-deploy-summary-schemas.js';

export * from './cleanup-settings-schemas.js';
export * from './cleanup-schemas.js';
export * from './cleanup.js';

export * from './job-delivery-schemas.js';

export * from './project-send-schemas.js';

export * from './ekoa-oauth-schemas.js';
export * from './owner-plugin.js';
export * from './claude-login.js';
export * from './project-jobs-view-schemas.js';
export * from './project-routine-editor-schemas.js';
export * from './project-routine-settings-schemas.js';
export * from './conversation-composer-schemas.js';
export * from './conversation-step-presentation-schemas.js';
export * from './conversation-decision-view-schemas.js';
export * from './account-copy.js';
export * from './project-placement-editor-schemas.js';
export * from './project-environment-editor-schemas.js';
export * from './notification-editor-schemas.js';
