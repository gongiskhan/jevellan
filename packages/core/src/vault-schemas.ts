import { z } from 'zod';
import { GoalAutonomySchema, GoalStateSchema } from './project-goal-schemas.js';
import { JobRunSpecSchema } from './project-daily-schemas.js';
import { TaskTypeSchema } from './project-loop-schemas.js';
import { ProjectWorkSettingsSchema } from './project-schemas.js';

const name = z.string().trim().min(1).max(120);
const settings = ProjectWorkSettingsSchema.shape;
/**
 * A project's definition in the vault (`projects/<owner>__<repo>/project.json`, phase 5): what a person would otherwise retype on a new
 * hub. It names goals and jobs by name and never holds secrets, account ids, device ids or any one device's paths.
 */
export const VaultProjectSchema = z.strictObject({
  schema: z.literal('vault-project-v1'),
  name: name, origin: z.string().min(1).max(500),
  testCommand: z.string().max(2000).nullable(), setupCommand: settings.setupCommand, gitPolicy: z.enum(['main', 'external']),
  work: z.strictObject({
    defaultIsolation: settings.defaultIsolation, allowMainIsolation: settings.allowMainIsolation,
    maxRunningThreads: settings.maxRunningThreads, maxRunningPerDevice: settings.maxRunningPerDevice, threadTurnCap: settings.threadTurnCap,
    threadRules: settings.threadRules, riskyAreas: settings.riskyAreas, requiredChecks: settings.requiredChecks, autoMerge: settings.autoMerge,
    nightlyWindow: settings.nightlyWindow, refill: settings.refill, memory: settings.memory, sessionCheckpoints: settings.sessionCheckpoints,
    compactAtPercent: settings.compactAtPercent,
    coordinator: z.strictObject({ runtimeId: z.string().min(1).max(200).nullable(), modelId: z.string().min(1).max(200).nullable(), effort: settings.coordinator.shape.effort }),
  }),
  goals: z.array(z.strictObject({ name: z.string().trim().min(1).max(80), state: GoalStateSchema, motivation: z.string().trim().min(1).max(4000), health: z.string().max(1000),
    autonomy: GoalAutonomySchema, dailyRefillCap: z.number().int().min(0).max(20), openPrCap: z.number().int().min(1).max(10) })).max(100),
  jobs: z.array(z.strictObject({ name: z.string().min(1).max(80), goal: z.string().max(80).nullable(), run: JobRunSpecSchema, gate: z.string().max(80).nullable(), enabled: z.boolean() })).max(100),
  dailies: z.array(z.strictObject({ name: z.string().min(1).max(80), goal: z.string().max(80).nullable(), order: z.number().int().min(0).max(100), enabled: z.boolean(),
    target: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('memory-dream') }), z.strictObject({ kind: z.literal('job'), job: z.string().min(1).max(80) }),
      z.strictObject({ kind: z.literal('review-since-last') }), z.strictObject({ kind: z.literal('session'), title: z.string().min(1).max(120), brief: z.string().min(1).max(20000), type: TaskTypeSchema })]) })).max(100),
});
export type VaultProject = z.infer<typeof VaultProjectSchema>;
export const VaultViewSchema = z.strictObject({ schema: z.literal('vault-view-v1'), remote: z.string().nullable(), lastSyncAt: z.string().nullable(), lastError: z.string().nullable(),
  pending: z.boolean(), folders: z.array(z.string().max(210)).max(1000) });
export type VaultView = z.infer<typeof VaultViewSchema>;
