import { ProjectSetupPresentationSchema } from './project-setup-copy-schemas.js';
import { z } from 'zod';
import { IdSchema, ProjectSchema, TimestampSchema, type Project } from './schemas.js';
import { ProjectWorkSettingsSchema, type ProjectWorkSettings } from './project-schemas.js';
import { GoalCreateRequestSchema, ProjectGoalSchema } from './project-goal-schemas.js';
import { EnvNameSchema } from './project-parity-schemas.js';
const revision = z.number().int().nonnegative();
export const ProjectSetupItemSchema = z.strictObject({ key: z.enum(['testCommand', 'setupCommand', 'instructions', 'copyFiles', 'variables', 'secrets', 'goal']), value: z.string().min(1).max(16000), note: z.string().max(300).optional() });
export const ProjectSetupItemsSchema = z.array(ProjectSetupItemSchema).min(1).max(12).refine(items => items.filter(item => item.key === 'goal').length <= 3, 'Propose at most three goals.');
export const ProjectSetupProposalSchema = z.strictObject({ schema: z.literal('project-setup-proposal-v1'), revision,
  id: IdSchema, projectId: IdSchema, createdAt: TimestampSchema, items: ProjectSetupItemsSchema,
  appliedAt: TimestampSchema.optional(), applied: z.array(z.number().int().nonnegative()).max(12).optional(), dismissedAt: TimestampSchema.optional() });
export type ProjectSetupProposal = z.infer<typeof ProjectSetupProposalSchema>;
export const SetupProposeInputSchema = z.strictObject({ items: ProjectSetupItemsSchema });
export const SetupProposalResultSchema = z.strictObject({ schema: z.literal('setup-proposal-result-v1'), proposal: ProjectSetupProposalSchema });
export const SetupProposalViewSchema = z.strictObject({ schema: z.literal('setup-proposal-view-v1'), proposal: ProjectSetupProposalSchema, settingsRevision: revision, projectRevision: revision, presentation: ProjectSetupPresentationSchema.optional() });
const selection = z.array(z.strictObject({ index: z.number().int().min(0).max(11), value: ProjectSetupItemSchema.shape.value })).min(1).max(12)
  .refine(items => new Set(items.map(item => item.index)).size === items.length, 'Choose each setup item once.');
const base = { schema: z.literal('setup-action-request-v1'), clientRequestId: IdSchema, expectedRevision: revision };
export const SetupActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...base, action: z.literal('apply'), settingsRevision: revision, projectRevision: revision, selected: selection }),
  z.strictObject({ ...base, action: z.literal('dismiss') }),
]);
export type SetupActionRequest = z.infer<typeof SetupActionRequestSchema>;
const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
/** Validate the whole selected result before the hub writes any of it. */
export function projectSetupPlan(proposal: ProjectSetupProposal, selected: z.infer<typeof selection>, settings: ProjectWorkSettings, project: Project, at: string) {
  const next = structuredClone(settings), registration = structuredClone(project), goals = [];
  let projectChanged = false;
  for (const chosen of [...selection.parse(selected)].sort((a, b) => a.index - b.index)) {
    const item = proposal.items[chosen.index]; if (!item) throw new Error('This setup item does not exist.');
    const value = chosen.value;
    switch (item.key) {
      case 'testCommand': projectChanged ||= registration.testCommand !== value; registration.testCommand = value; break;
      case 'setupCommand': next.setupCommand = value; break;
      case 'instructions': next.instructions = value; break;
      case 'copyFiles': next.environment.copyFiles = lines(value); break;
      case 'variables': for (const name of lines(value).map(name => EnvNameSchema.parse(name))) if (!next.environment.variables.some(row => row.name === name)) next.environment.variables.push({ name, value: '' }); break;
      case 'secrets': next.environment.secrets = [...new Set([...next.environment.secrets, ...lines(value).map(name => EnvNameSchema.parse(name))])]; break;
      case 'goal': {
        const [name, ...motivation] = value.split('\n');
        const fields = GoalCreateRequestSchema.parse({ schema: 'goal-create-request-v1', clientRequestId: proposal.id, name, motivation: motivation.join('\n').trim(), state: 'paused', autonomy: 'propose' });
        const { schema, clientRequestId, ...rest } = fields; void schema; void clientRequestId;
        goals.push(ProjectGoalSchema.parse({ schema: 'project-goal-v1', id: `${proposal.id}_goal_${chosen.index}`, projectId: project.id, revision: 0, createdAt: at, updatedAt: at, ...rest })); break;
      }
    }
  }
  return { settings: ProjectWorkSettingsSchema.parse(next), project: ProjectSchema.parse(registration), projectChanged, goals };
}
