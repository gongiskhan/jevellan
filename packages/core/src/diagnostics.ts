import { join } from 'node:path';
import { z } from 'zod';
import type { Homes } from './homes.js';

export const DiagnosticCheckSchema = z.strictObject({
  id: z.enum(['node', 'git', 'apm', 'basic-memory', 'claude', 'codex', 'daemon', 'hub', 'accounts', 'jev']),
  status: z.enum(['ok', 'missing', 'warning', 'error']), note: z.string().min(1).max(512),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;
export const DaemonDiagnosticsSchema = z.strictObject({
  schema: z.literal('daemon-diagnostics-v1'), version: z.string().min(1),
  checks: z.tuple([
    DiagnosticCheckSchema.extend({ id: z.literal('hub') }),
    DiagnosticCheckSchema.extend({ id: z.literal('accounts') }),
    DiagnosticCheckSchema.extend({ id: z.literal('jev') }),
  ]),
});
export const DoctorReportSchema = z.strictObject({ schema: z.literal('doctor-report-v1'), at: z.iso.datetime(), checks: z.array(DiagnosticCheckSchema) });
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export const DoctorControlSchema = z.strictObject({
  schema: z.literal('doctor-control-v1'),
  origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/).refine(value => Number(value.split(':').at(-1)) <= 65535),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export function doctorControlPath(homes: Homes): string {
  const path = join(homes.root, 'doctor.json');
  if (homes.at('doctor.json') !== path) throw new Error('The local diagnostics file cannot alias another location.');
  return path;
}
