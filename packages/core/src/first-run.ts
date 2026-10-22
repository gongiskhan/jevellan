import { z } from 'zod';
import { AuthSchema, IdSchema } from './schemas.js';
export const FirstRunStepSchema = z.enum(['jev', 'account', 'project', 'conversation']);
export const FirstRunReadRequestSchema = z.strictObject({ schema: z.literal('first-run-read-request-v1'), step: z.string().max(200).nullable().default(null) });
export const FirstRunNextRequestSchema = z.strictObject({ schema: z.literal('first-run-next-request-v1'), step: FirstRunStepSchema });
export const FirstRunFactsSchema = z.strictObject({ schema: z.literal('first-run-facts-v1'), deviceId: IdSchema, jevSaved: z.boolean(),
  accounts: z.array(z.strictObject({ enabled: z.boolean(), runtime: IdSchema, statuses: z.array(z.strictObject({ deviceId: IdSchema, auth: AuthSchema })).max(10000) })).max(10000),
  runtimes: z.array(z.strictObject({ id: IdSchema, enabled: z.boolean() })).max(10000),
  projects: z.array(z.strictObject({ paths: z.record(IdSchema, z.string().max(10000)), allowedDevices: z.array(IdSchema).max(10000).optional() })).max(10000) });
const navigation = z.strictObject({ label: z.string(), path: z.string().startsWith('/setup?step=') });
const step = z.strictObject({ id: FirstRunStepSchema, label: z.string(), number: z.number().int().positive(), path: z.string().startsWith('/setup?step=') });
export const FirstRunViewSchema = z.strictObject({ schema: z.literal('first-run-view-v1'), deviceId: IdSchema, total: z.number().int().positive(), positionLabel: z.string(),
  steps: z.array(step).min(1), current: step.omit({ path: true }).extend({ title: z.string(), explanation: z.string() }), jevSaved: z.boolean(), authenticatedOnDevice: z.boolean(), projectOnDevice: z.boolean(), hint: z.string().nullable(),
  actions: z.strictObject({ back: navigation.nullable(), skip: navigation.nullable(), next: z.strictObject({ label: z.string(), enabled: z.boolean(), request: z.strictObject({ path: z.literal('/api/setup/next'), body: FirstRunNextRequestSchema }) }).nullable() }),
  paths: z.strictObject({ read: z.literal('/api/setup/progress') }) });
export const FirstRunNavigationSchema = z.strictObject({ schema: z.literal('first-run-navigation-v1'), deviceId: IdSchema, allowed: z.boolean(), path: z.string().startsWith('/setup?step=').nullable(), refusal: z.string().nullable(), view: FirstRunViewSchema })
  .refine(value => value.deviceId === value.view.deviceId && value.allowed === (value.path !== null) && (value.allowed ? value.refusal === null : value.refusal !== null), 'The setup navigation does not match its device or availability.');
export type FirstRunView = z.infer<typeof FirstRunViewSchema>;
export const FIRST_RUN_LOADING = 'Loading setup…';
const steps = [
  { id: 'jev' as const, label: 'Jev key', title: 'Connect Jev', explanation: 'Add your Jev key to let it choose each next step, or skip to choose steps yourself.' },
  { id: 'account' as const, label: 'Account', title: 'Add your first account', explanation: 'Choose a runtime and sign in with an account Jevellan can use.' },
  { id: 'project' as const, label: 'Project', title: 'Add your first project', explanation: 'Choose a project already checked out on this device.' },
  { id: 'conversation' as const, label: 'Conversation', title: 'Start your first conversation', explanation: 'Describe what you want to build or fix in that project.' },
];
/** Setup checks authentication completion; the existing ranked work-admission limits still apply when work starts. */
export function firstRunView(raw: unknown, selected: string | null = null): FirstRunView {
  const facts = FirstRunFactsSchema.parse(raw), input = FirstRunReadRequestSchema.parse({ schema: 'first-run-read-request-v1', step: selected });
  const index = Math.max(0, steps.findIndex(row => row.id === input.step)), current = steps[index]!;
  const authenticatedOnDevice = facts.accounts.some(account => account.enabled && facts.runtimes.some(runtime => runtime.id === account.runtime && runtime.enabled) && account.statuses.some(status => status.deviceId === facts.deviceId && status.auth === 'ready'));
  const projectOnDevice = facts.projects.some(project => !!project.paths[facts.deviceId] && (!project.allowedDevices || project.allowedDevices.includes(facts.deviceId)));
  const progress = steps.map((row, index) => ({ id: row.id, label: row.label, number: index + 1, path: `/setup?step=${row.id}` }));
  return FirstRunViewSchema.parse({ schema: 'first-run-view-v1', deviceId: facts.deviceId, total: steps.length, positionLabel: `Step ${index + 1} of ${steps.length}`, steps: progress,
    current: { ...current, number: index + 1 }, jevSaved: facts.jevSaved, authenticatedOnDevice, projectOnDevice,
    hint: current.id === 'account' && !authenticatedOnDevice ? 'Continue when an account is Ready on this device.' : null,
    actions: { back: index > 0 ? { label: 'Back', path: progress[index - 1]!.path } : null, skip: current.id === 'jev' && !facts.jevSaved ? { label: 'Skip for now', path: progress[1]!.path } : null,
      next: index < steps.length - 1 ? { label: 'Continue', enabled: current.id === 'jev' ? facts.jevSaved : current.id === 'account' ? authenticatedOnDevice : true,
        request: { path: '/api/setup/next', body: { schema: 'first-run-next-request-v1', step: current.id } } } : null }, paths: { read: '/api/setup/progress' } });
}
/** This plan is computed again from fresh server facts at the normal Next endpoint; posted views are never authority. */
export function firstRunNext(raw: unknown) {
  const view = FirstRunViewSchema.parse(raw), next = view.actions.next;
  const refusal = !next ? 'Setup is already at its last step.' : !next.enabled ? view.current.id === 'jev' ? 'Add your Jev key before continuing.' : 'Continue when an account is Ready on this device.'
    : view.current.id === 'project' && !view.projectOnDevice ? 'Add a project on this device before continuing.' : null;
  const path = refusal === null ? view.steps[view.current.number]!.path : null;
  return FirstRunNavigationSchema.parse({ schema: 'first-run-navigation-v1', deviceId: view.deviceId, allowed: refusal === null, path, refusal, view });
}
