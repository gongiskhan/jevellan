import { ProjectSetupProposalSchema } from './project-setup-schemas.js';
import { ProjectSetupPresentationSchema } from './project-setup-copy-schemas.js';
export const SETUP_LABELS = { testCommand: 'Test command', setupCommand: 'Worktree setup command', instructions: 'Project instructions', copyFiles: 'Copy into new worktrees', variables: 'Variables to fill in', secrets: 'Secrets to fill in' };
export const setupGoalLabel = (value: string) => `Goal: ${value.split('\n')[0]}`;
export const setupApplied = (count: number) => `Setup applied: ${count} changes.`;
export function projectSetupPresentation(raw: unknown) {
  const proposal = ProjectSetupProposalSchema.parse(raw);
  return ProjectSetupPresentationSchema.parse({ schema: 'project-setup-presentation-v1', items: proposal.items.map((item, index) => ({ index, label: item.key === 'goal' ? setupGoalLabel(item.value) : SETUP_LABELS[item.key] })),
    appliedLine: proposal.appliedAt ? setupApplied(proposal.applied?.length ?? 0) : null,
  });
}
