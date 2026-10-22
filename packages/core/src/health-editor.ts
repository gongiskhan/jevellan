import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { HealthStepSchema, ProjectHealthCheckSchema, ProjectHealthChecksSchema, ProjectHealthRequestSchema, ProjectHealthRunSchema, ProjectHealthViewSchema, type ProjectHealthCheck, type ProjectHealthRun } from './project-health-schemas.js';

// Raw controls deliberately admit unfinished values; every run/save still parses the canonical definitions.
const step = z.strictObject({ name: z.string().max(4000), method: HealthStepSchema.shape.method, url: z.string().max(4000), headers: z.string().max(40000), body: z.string().max(4000), expectStatus: z.string().max(1000), expectBody: z.string().max(4000), timeoutMs: z.string().max(100) });
const check = z.strictObject({ id: IdSchema, name: z.string().max(4000), enabled: z.boolean(), steps: z.array(step).max(10) });
const fields = z.array(check).max(100);
export const HealthEditorPreviewSchema = z.strictObject({ schema: z.literal('health-editor-preview-v1'), projectId: IdSchema, fields });
export const HealthEditorCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('health-editor-command-v1'), operation: z.literal('add-check') }),
  z.strictObject({ schema: z.literal('health-editor-command-v1'), operation: z.literal('remove-check'), checkId: IdSchema }),
  z.strictObject({ schema: z.literal('health-editor-command-v1'), operation: z.literal('check'), checkId: IdSchema, patch: check.pick({ name: true, enabled: true }).partial() }),
  z.strictObject({ schema: z.literal('health-editor-command-v1'), operation: z.literal('step'), checkId: IdSchema, index: z.number().int().nonnegative(), patch: step.partial() }),
  z.strictObject({ schema: z.literal('health-editor-command-v1'), operation: z.literal('add-step'), checkId: IdSchema }),
  z.strictObject({ schema: z.literal('health-editor-command-v1'), operation: z.literal('remove-step'), checkId: IdSchema, index: z.number().int().nonnegative() }),
]);
const errors = z.array(z.strictObject({ path: z.string(), message: z.string() }));
export const HealthEditorSchema = z.strictObject({ schema: z.literal('health-editor-v1'), projectId: IdSchema, fields, candidateIds: z.array(IdSchema).length(10), retiredIds: z.array(IdSchema).max(10), needsCandidate: z.boolean(),
  newStep: step, limits: z.strictObject({ checks: z.number(), steps: z.number(), name: z.number(), url: z.number(), body: z.number(), expectBody: z.number(), timeout: z.strictObject({ min: z.number(), max: z.number() }) }),
  methods: z.array(z.strictObject({ value: HealthStepSchema.shape.method, label: z.string() })), notice: z.string(), canAddCheck: z.boolean(),
  checks: z.array(z.strictObject({ id: IdSchema, canAddStep: z.boolean(), canRemoveStep: z.boolean(), runEnabled: z.boolean() })), apply: z.strictObject({ enabled: z.boolean(), errors }), patch: ProjectHealthChecksSchema.nullable() });
export type HealthEditor = z.infer<typeof HealthEditorSchema>;
export type HealthEditorCommand = z.infer<typeof HealthEditorCommandSchema>;
function definition(raw: z.infer<typeof check>): unknown {
  return { ...raw, steps: raw.steps.map(row => {
    let headers: unknown;
    try { headers = JSON.parse(row.headers); } catch { throw new Error('Headers must be a JSON object of text values.'); }
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || !Object.values(headers).every(value => typeof value === 'string')) throw new Error('Headers must be a JSON object of text values.');
    return { ...row, headers, body: row.body || null, expectBody: row.expectBody || null, expectStatus: row.expectStatus.split(',').map(value => Number(value.trim())), timeoutMs: Number(row.timeoutMs) };
  }) };
}
function validate(raw: z.infer<typeof fields>) {
  try { return { patch: ProjectHealthChecksSchema.parse(raw.map(definition)), errors: [] }; }
  catch (error) { return { patch: null, errors: error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) : [{ path: 'headers', message: error instanceof Error ? error.message : 'Could not validate health checks.' }] }; }
}
export function healthEditorPreview(raw: unknown, candidateIds: string[], retiredIds: string[] = []): HealthEditor {
  const input = HealthEditorPreviewSchema.parse(raw), parsed = validate(input.fields), shape = HealthStepSchema.shape;
  const bound = (schema: z.ZodType, key: string) => Number(z.toJSONSchema(schema, { io: 'input' })[key]);
  const limits = { checks: bound(ProjectHealthChecksSchema, 'maxItems'), steps: bound(ProjectHealthCheckSchema.shape.steps, 'maxItems'), name: shape.name.maxLength!, url: shape.url.maxLength!, body: bound(shape.body, 'maxLength'), expectBody: bound(shape.expectBody, 'maxLength'), timeout: { min: 1000, max: 30000 } };
  // Nullable/default schemas express their string bounds inside a union, not at its root.
  limits.body = shape.body.removeDefault().unwrap().maxLength!; limits.expectBody = shape.expectBody.removeDefault().unwrap().maxLength!;
  const base = shape.timeoutMs.parse(undefined); limits.timeout = { min: bound(shape.timeoutMs.removeDefault(), 'minimum'), max: bound(shape.timeoutMs.removeDefault(), 'maximum') };
  return HealthEditorSchema.parse({ schema: 'health-editor-v1', projectId: input.projectId, fields: input.fields, candidateIds, retiredIds, needsCandidate: !candidateIds.some(id => !input.fields.some(row => row.id === id) && !retiredIds.includes(id)),
    newStep: { name: 'The app answers', method: 'GET', url: 'https://', headers: '{}', body: '', expectStatus: '200', expectBody: '', timeoutMs: String(base) }, limits,
    methods: shape.method.options.map(value => ({ value, label: value })), notice: 'Checks run around deploys and when you press Run now. They never sign in. Save changes to keep these definitions.',
    canAddCheck: input.fields.length < limits.checks,
    checks: input.fields.map(row => ({ id: row.id, canAddStep: row.steps.length < limits.steps, canRemoveStep: row.steps.length > 1, runEnabled: validate([row]).patch !== null })), apply: { enabled: parsed.patch !== null, errors: parsed.errors }, patch: parsed.patch });
}
export function healthEditor(projectId: string, checks: ProjectHealthCheck[], candidateIds: string[]): HealthEditor {
  const canonical = ProjectHealthChecksSchema.parse(checks);
  return healthEditorPreview({ schema: 'health-editor-preview-v1', projectId, fields: canonical.map(row => ({ ...row, steps: row.steps.map(value => ({ ...value, headers: JSON.stringify(value.headers), body: value.body ?? '', expectBody: value.expectBody ?? '', expectStatus: value.expectStatus.join(', '), timeoutMs: String(value.timeoutMs) })) })) }, candidateIds);
}
export function healthEditorEdit(raw: unknown, command: unknown): HealthEditor {
  const model = HealthEditorSchema.parse(raw), input = HealthEditorCommandSchema.parse(command), next = structuredClone(model.fields);
  if (input.operation === 'add-check') {
    const id = model.candidateIds.find(candidate => !next.some(row => row.id === candidate) && !model.retiredIds.includes(candidate));
    if (!model.canAddCheck) throw new Error('A project can have at most ten health checks.');
    if (!id) throw new Error('Refresh health check identities.');
    next.push({ id, name: 'New check', enabled: true, steps: [model.newStep] });
  } else {
    const index = next.findIndex(row => row.id === input.checkId), row = next[index];
    if (!row) throw new Error('Health check not found.');
    if (input.operation === 'remove-check') { next.splice(index, 1); if (model.candidateIds.includes(row.id) && !model.retiredIds.includes(row.id)) model.retiredIds.push(row.id); }
    else if (input.operation === 'check') Object.assign(row, input.patch);
    else if (input.operation === 'add-step') { if (row.steps.length >= model.limits.steps) throw new Error('A health check can have at most five steps.'); row.steps.push(model.newStep); }
    else {
      if (!row.steps[input.index]) throw new Error('Health step not found.');
      if (input.operation === 'step') Object.assign(row.steps[input.index]!, input.patch);
      else { if (row.steps.length <= 1) throw new Error('A health check needs at least one step.'); row.steps.splice(input.index, 1); }
    }
  }
  return healthEditorPreview({ schema: 'health-editor-preview-v1', projectId: model.projectId, fields: next }, model.candidateIds, model.retiredIds);
}
export function healthRunRequest(raw: unknown, checkId: string) {
  const model = HealthEditorSchema.parse(raw), found = model.fields.find(row => row.id === checkId);
  if (!found) throw new Error('Health check not found.');
  return ProjectHealthRequestSchema.parse({ schema: 'project-health-request-v1', project: model.projectId, operation: 'run', definition: ProjectHealthCheckSchema.parse(definition(found)) });
}
const presented = z.strictObject({ runId: IdSchema, checkId: IdSchema, at: TimestampSchema, label: z.enum(['Passed', 'Failed']), steps: z.array(z.string()).min(1).max(5) });
export const HealthHistoryViewSchema = z.strictObject({ schema: z.literal('health-history-view-v1'), projectId: IdSchema, source: ProjectHealthViewSchema, runs: z.array(presented).max(5000) });
export type HealthHistoryView = z.infer<typeof HealthHistoryViewSchema>;
export function healthHistoryMerge(projectId: string, previous: ProjectHealthRun[], incoming: unknown): ProjectHealthRun[] {
  const view = ProjectHealthViewSchema.parse(incoming), prior = z.array(ProjectHealthRunSchema).max(5000).parse(previous);
  if (view.projectId !== projectId || [...view.runs, ...prior].some(row => row.projectId !== projectId)) throw new Error('Health runs belong to another project.');
  const unique = new Map<string, ProjectHealthRun>(); for (const row of [...view.runs, ...prior]) if (!unique.has(row.id)) unique.set(row.id, row);
  return [...unique.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5000);
}
export function healthHistoryView(raw: unknown): HealthHistoryView {
  const view = ProjectHealthViewSchema.parse(raw), runs = healthHistoryMerge(view.projectId, [], view);
  return HealthHistoryViewSchema.parse({ schema: 'health-history-view-v1', projectId: view.projectId, source: { ...view, runs }, runs: runs.map(row => ({ runId: row.id, checkId: row.checkId, at: row.at, label: row.passed ? 'Passed' : 'Failed', steps: row.steps.map(value => `${value.name}: ${value.passed ? 'passed' : 'failed'} · ${value.ms} ms${value.reason ? ` · ${value.reason}` : value.status !== undefined ? ` · status ${value.status}` : ''}`) })) });
}
export function healthRecentRuns(raw: unknown, checkId: string) { return HealthHistoryViewSchema.parse(raw).runs.filter(row => row.checkId === checkId).slice(0, 5); }
