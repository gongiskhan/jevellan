import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProjectLandingEditorRequestSchema, ProjectLandingEditorSchema, ProjectLandingPatchSchema, LandingCheckSchema, ProjectWorkSettingsSchema, newId, stableJson } from '@jevellan/core';

const limits = {
  checks: Number(z.toJSONSchema(ProjectWorkSettingsSchema.shape.landingChecks).maxItems), paths: Number(z.toJSONSchema(LandingCheckSchema.shape.paths).maxItems),
  name: Number(z.toJSONSchema(LandingCheckSchema.shape.name).maxLength), command: Number(z.toJSONSchema(LandingCheckSchema.shape.command).maxLength),
  smokeCheck: Number(z.toJSONSchema(ProjectWorkSettingsSchema.shape.smokeCheck.removeDefault().unwrap()).maxLength),
  mergePaths: Number(z.toJSONSchema(ProjectWorkSettingsSchema.shape.mergeCommitPaths).maxItems),
};
const lines = (value: string) => value.split('\n').filter(Boolean);
function label(path: PropertyKey[]): string {
  if (path[0] === 'landingChecks') {
    if (typeof path[1] !== 'number') return 'Landing checks';
    const field = path[2] === 'name' ? 'name' : path[2] === 'command' ? 'command' : 'paths';
    return `Check ${path[1] + 1} ${field}`;
  }
  return path[0] === 'smokeCheck' ? 'Smoke check' : path[0] === 'mergeCommitPaths' ? 'Keep commits for these paths' : 'Landing settings';
}
/** Pure editor over an explicit versioned snapshot; no store read can silently replace a pending page draft. */
export function landingEditor(raw: unknown) {
  const input = ProjectLandingEditorRequestSchema.parse(raw), settings = input.settings;
  const fields = input.fields ?? { delivery: settings.delivery, autoLand: settings.autoLand,
    checks: settings.landingChecks.map(check => ({ name: check.name, paths: check.paths.join('\n'), command: check.command })),
    smokeCheck: settings.smokeCheck ?? '', mergeCommitPaths: settings.mergeCommitPaths.join('\n') };
  const parsed = ProjectLandingPatchSchema.safeParse({ delivery: fields.delivery, autoLand: fields.autoLand,
    landingChecks: fields.checks.map(check => ({ name: check.name, paths: lines(check.paths), command: check.command })), smokeCheck: fields.smokeCheck || null, mergeCommitPaths: lines(fields.mergeCommitPaths) });
  const base = { schema: 'project-landing-editor-request-v1' as const, settings, clientRequestId: input.clientRequestId ?? newId('landingform') };
  const clientRequestId = `landing_${createHash('sha256').update(stableJson({ base, fields })).digest('hex').slice(0, 40)}`;
  const { schema: _schema, projectId, revision, ...kept } = settings; void _schema;
  return ProjectLandingEditorSchema.parse({ schema: 'project-landing-editor-v1', projectId, fields, limits,
    deliveryChoices: [{ value: 'land', label: 'Land on main' }, { value: 'pull-request', label: 'Pull request' }],
    canAddCheck: fields.checks.length < limits.checks, newCheck: { name: '', paths: '', command: '' },
    routeHelp: 'Jev chooses the route after the configured checks pass. Existing threads keep their delivery.',
    pathsHelp: 'One file or directory per line. Empty runs for every change.', smokeHelp: 'Runs for every landing.',
    mergeHelp: 'Changes under these paths land with a merge commit. Other threads land as one squash commit.',
    apply: { enabled: parsed.success, errors: parsed.success ? [] : parsed.error.issues.map(issue => ({ label: label(issue.path), message: issue.message })).slice(0, 100) },
    patch: parsed.success ? parsed.data : null,
    saveRequest: parsed.success ? { schema: 'project-landing-editor-save-v1', projectId,
      settingsRequest: { schema: 'project-work-settings-request-v1', revision, clientRequestId, settings: { ...kept, ...parsed.data } } } : null,
    request: { previewPath: `/api/projects/${projectId}/config/landing-editor`, savePath: `/api/projects/${projectId}/config/landing-save`, base },
  });
}
