import { z } from 'zod';
import { ProjectJobEditorSchema, ProjectDailyEditorSchema, RoutineEditorSaveRequestSchema, JobCreateRequestSchema, JobUpdateRequestSchema,
  DailyCreateRequestSchema, DailyUpdateRequestSchema, JobRunSpecSchema, ProjectDailySchema, ProjectJobSchema, TaskTypeSchema, newId,
  type ProjectJob, type ProjectDaily, type RoutineEditorChoice } from '@jevellan/core';

const refuse = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const retired = 'GitHub workflow (retired 19 October). Its receipts remain available. Create a command job to replace it.';
const choice = (value: string, label: string): RoutineEditorChoice => ({ value, label, disabled: false, refusal: null });
const limit = (schema: z.ZodType, key: 'minimum' | 'maximum' | 'maxLength' | 'maxItems') => {
  const value = (z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>)[key];
  if (typeof value !== 'number') throw new Error(`The editor schema has no ${key}.`);
  return value;
};
const command = JobRunSpecSchema.options[0];
const numberLimits = (schema: z.ZodType) => ({ min: limit(schema, 'minimum'), max: limit(schema, 'maximum') });
const targetSession = ProjectDailySchema.shape.target.options[3];
export function jobEditorView(projectId: string, item: ProjectJob | undefined, choices: { goals: RoutineEditorChoice[]; gates: RoutineEditorChoice[] }) {
  const run = item?.run.kind === 'command' ? item.run : undefined;
  return ProjectJobEditorSchema.parse({ schema: 'project-job-editor-v1', projectId, itemId: item?.id ?? null, title: item ? 'Edit job' : 'New job', readonly: item?.run.kind === 'github-workflow',
    notice: item?.run.kind === 'github-workflow' ? retired : null,
    defaults: { name: item?.name ?? '', goalId: item?.goalId ?? '', enabled: item?.enabled ?? true, command: run?.command ?? '', needs: run?.needs.join(', ') ?? '',
      cwd: run?.cwd ?? 'checkout', timeoutMinutes: String(item?.run.timeoutMinutes ?? 30), gate: item?.gate?.jobId ?? '', intervalEnabled: !!item?.interval,
      everyMinutes: String(item?.interval?.everyMinutes ?? 10), intervalStart: item?.interval?.start ?? '08:00', intervalEnd: item?.interval?.end ?? '23:00' },
    constraints: { nameMax: limit(JobCreateRequestSchema.shape.name, 'maxLength'), commandMax: limit(command.shape.command, 'maxLength'),
      needsMax: limit(command.shape.needs, 'maxItems') * 33, timeoutMinutes: numberLimits(command.shape.timeoutMinutes), everyMinutes: numberLimits(ProjectJobSchema.shape.interval.unwrap().shape.everyMinutes) },
    choices: { goals: [choice('', 'Asks'), ...choices.goals], gates: [choice('', 'No gate'), ...choices.gates], cwd: [choice('checkout', 'Clean checkout'), choice('workspace', 'Retained workspace')] },
    request: { path: item ? `/api/projects/${projectId}/jobs/${item.id}/editor` : `/api/projects/${projectId}/jobs/editor`,
      base: item ? { schema: 'job-editor-update-request-v1', expectedRevision: item.revision } : { schema: 'job-editor-create-request-v1', clientRequestId: newId('jform') } } });
}
export function dailyEditorView(projectId: string, item: ProjectDaily | undefined, jobs: readonly ProjectJob[], goals: { ordinary: RoutineEditorChoice[]; review: RoutineEditorChoice[] }) {
  const target = item?.target, jobChoices = jobs.filter(job => job.run.kind === 'command').map(job => choice(job.id, job.name));
  const ordinary = [choice('', 'Asks'), ...goals.ordinary], review = [choice('', 'Asks'), ...goals.review];
  return ProjectDailyEditorSchema.parse({ schema: 'project-daily-editor-v1', projectId, itemId: item?.id ?? null, title: item ? 'Edit nightly item' : 'New nightly item',
    defaults: { name: item?.name ?? '', goalId: item?.goalId ?? '', enabled: item?.enabled ?? true, order: String(item?.order ?? 0), days: item?.days ?? [], kind: target?.kind ?? 'job',
      jobId: target?.kind === 'job' ? target.jobId : jobChoices[0]?.value ?? '', title: target?.kind === 'session' ? target.title : '', brief: target?.kind === 'session' ? target.brief : '',
      type: target?.kind === 'session' ? target.type : 'review', reviewFrom: target?.kind === 'review-since-last' ? target.reviewFromCommit ?? '' : '' },
    constraints: { nameMax: limit(DailyCreateRequestSchema.shape.name, 'maxLength'), titleMax: limit(targetSession.shape.title, 'maxLength'), briefMax: limit(targetSession.shape.brief, 'maxLength'),
      order: numberLimits(DailyCreateRequestSchema.shape.order), reviewFromPattern: '[0-9a-f]{40}', reviewFromMax: 40 },
    choices: { jobs: jobChoices, kinds: [choice('job', 'Job'), choice('session', 'Thread'), choice('review-since-last', 'Review since last'), choice('memory-dream', 'Memory dream')],
      types: TaskTypeSchema.options.map(value => choice(value, value)), days: ProjectDailySchema.shape.days.unwrap().element.options.map(day => choice(day, day[0]!.toUpperCase() + day.slice(1))),
      goalsByKind: { job: ordinary, session: ordinary, 'review-since-last': review, 'memory-dream': ordinary } },
    notesByKind: { job: null, session: null, 'review-since-last': 'Read-only, high effort, on the other provider. Every commit since the last completed review is included.', 'memory-dream': 'Memory dream runs before command jobs.' },
    fieldsByKind: { job: { job: true, session: false, review: false }, session: { job: false, session: true, review: false },
      'review-since-last': { job: false, session: false, review: true }, 'memory-dream': { job: false, session: false, review: false } },
    request: { path: item ? `/api/projects/${projectId}/dailies/${item.id}/editor` : `/api/projects/${projectId}/dailies/editor`,
      base: item ? { schema: 'daily-editor-update-request-v1', expectedRevision: item.revision } : { schema: 'daily-editor-create-request-v1', clientRequestId: newId('dform') } } });
}
/** Form encoding is transport data; the existing strict canonical writers retain all validation and effects. */
export function routineEditorRequest(raw: unknown, item?: ProjectJob | ProjectDaily) {
  const input = RoutineEditorSaveRequestSchema.parse(raw);
  switch (input.schema) {
    case 'job-editor-create-request-v1': case 'job-editor-update-request-v1': {
      if (item && 'run' in item && item.run.kind === 'github-workflow') return refuse(retired);
      if ((input.schema === 'job-editor-update-request-v1') !== !!item) return refuse('The editor request does not match this job.');
      const fields = input.fields, prior = item && 'run' in item && item.run.kind === 'command' ? item.run : undefined;
      const values = { name: fields.name, goalId: fields.goalId || null, enabled: fields.enabled, gate: fields.gate ? { jobId: fields.gate } : null,
        run: { ...prior, kind: 'command' as const, command: fields.command, needs: fields.needs.split(/[,\s]+/u).filter(Boolean), cwd: fields.cwd, timeoutMinutes: Number(fields.timeoutMinutes) },
        interval: fields.intervalEnabled ? { everyMinutes: Number(fields.everyMinutes), start: fields.intervalStart, end: fields.intervalEnd } : undefined };
      return input.schema === 'job-editor-create-request-v1' ? JobCreateRequestSchema.parse({ ...values, schema: 'job-create-request-v1', clientRequestId: input.clientRequestId })
        : JobUpdateRequestSchema.parse({ ...values, schema: 'job-update-request-v1', expectedRevision: input.expectedRevision });
    }
    case 'daily-editor-create-request-v1': case 'daily-editor-update-request-v1': {
      if ((input.schema === 'daily-editor-update-request-v1') !== !!item) return refuse('The editor request does not match this nightly item.');
      const fields = input.fields, target = fields.kind === 'job' ? { kind: fields.kind, jobId: fields.jobId } : fields.kind === 'session' ? { kind: fields.kind, title: fields.title, brief: fields.brief, type: fields.type }
        : fields.kind === 'review-since-last' ? { kind: fields.kind, ...(fields.reviewFrom ? { reviewFromCommit: fields.reviewFrom } : {}) } : { kind: fields.kind };
      const values = { name: fields.name, goalId: fields.goalId || null, enabled: fields.enabled, order: Number(fields.order), days: fields.days.length ? fields.days : undefined, target };
      return input.schema === 'daily-editor-create-request-v1' ? DailyCreateRequestSchema.parse({ ...values, schema: 'daily-create-request-v1', clientRequestId: input.clientRequestId })
        : DailyUpdateRequestSchema.parse({ ...values, schema: 'daily-update-request-v1', expectedRevision: input.expectedRevision });
    }
  }
}
