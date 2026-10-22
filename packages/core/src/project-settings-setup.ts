import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { EkoaCodeSetupRequestSchema } from './ekoa-code-schemas.js';
const pathFor = (projectId: string) => `/api/projects/${projectId}/ekoa-code-setup`;
export const ProjectSettingsSetupSchema = z.strictObject({ schema: z.literal('project-settings-setup-v1'), projectId: IdSchema,
  label: z.string().min(1).max(100), path: z.string().min(1).max(1000), workflowPull: z.number().int().positive() })
  .refine(value => value.path === pathFor(value.projectId), 'The setup path belongs to another project.');
export const ProjectSettingsSetupActionSchema = z.strictObject({ schema: z.literal('project-settings-setup-action-v1'), projectId: IdSchema,
  label: z.string().min(1).max(100), enabled: z.boolean(), path: z.string().min(1).max(1000), body: EkoaCodeSetupRequestSchema.nullable() })
  .refine(value => value.path === pathFor(value.projectId) && value.enabled === (value.body !== null), 'The setup action does not match its scope or availability.');
/** Preserve the existing named preset offer; canonical repository/model admission stays in the writer. */
export function projectSettingsSetupMetadata(projectId: string, projectName: string) {
  if (projectName !== 'Ekoa Code') return null;
  return ProjectSettingsSetupSchema.parse({ schema: 'project-settings-setup-v1', projectId, label: 'Apply Ekoa Code setup', path: pathFor(projectId), workflowPull: 208 });
}
/** Draft model selection is explicit input; a stale editor never prepares another project's action. */
export function projectSettingsSetupAction(raw: unknown, projectId: string, modelId: string | null) {
  IdSchema.parse(projectId);
  if (raw === null || raw === undefined) return null;
  const model = ProjectSettingsSetupSchema.parse(raw), selected = IdSchema.nullable().parse(modelId);
  if (model.projectId !== projectId) return null;
  return ProjectSettingsSetupActionSchema.parse({ schema: 'project-settings-setup-action-v1', projectId, label: model.label, path: model.path, enabled: selected !== null,
    body: selected === null ? null : EkoaCodeSetupRequestSchema.parse({ schema: 'ekoa-code-setup-request-v1', modelId: selected, workflowPull: model.workflowPull }) });
}
