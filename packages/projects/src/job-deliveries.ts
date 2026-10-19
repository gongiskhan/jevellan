import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IdSchema, TimestampSchema, JobDeliveriesSchema, JobDeliveryReceiptSchema, readDocument, writeDocument, type Homes, type ProjectJobRun, type ProjectLibrary, type SecretRedactor } from '@jevellan/core';
import { openProjectOutput } from '@jevellan/conversations';
import type { ThreadGit } from './git.js';

export const PrivateJobDeliverySchema = z.strictObject({ schema: z.literal('private-job-delivery-v1'), runId: z.string().min(1), deliveryId: z.string().min(1), trustedCommit: z.string().regex(/^[a-f0-9]{40}$/u), sha256: z.string().regex(/^[a-f0-9]{64}$/u), input: z.unknown() });
export const JobGateResultSchema = z.strictObject({ schema: z.literal('project-job-gate-result-v1'), trustedCommit: z.string().regex(/^[a-f0-9]{40}$/u), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/u), passed: z.boolean(), checks: z.array(z.strictObject({ name: z.string().min(1).max(100), passed: z.boolean() })).min(1).max(30) });
export const LegalLandingReceiptsSchema = z.strictObject({ schema: z.literal('jevellan-legal-landings-v1'), merges: z.array(z.strictObject({ taskId: IdSchema, pr: IdSchema, runId: IdSchema, deliveryId: IdSchema, title: z.string().min(1).max(120), mergedAt: TimestampSchema, mergeSha: z.string().regex(/^[a-f0-9]{40}$/u), gate: z.string().min(1), mergeStrategy: z.literal('merge'), gatePassed: z.literal(true), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) })).max(1000), reverts: z.array(z.strictObject({ mergeSha: z.string().regex(/^[a-f0-9]{40}$/u) })).max(1000) });
export const deliveryDirectory = (homes: Homes, projectId: string, runId: string) => homes.ensure('project-work', projectId, 'job-cache', 'deliveries', runId);
async function bytes(root: string, ref: string, expected: string, limit: number) {
  const opened = await openProjectOutput(root, ref, limit, 'The job artifact exceeds its limit.');
  try { const data = await opened.handle.readFile(); if (createHash('sha256').update(data).digest('hex') !== expected) throw new Error('The job artifact changed after publication.'); return data; }
  finally { await opened.handle.close(); }
}
/** A command emits data only. The daemon uploads dev artifacts and publishes base-only branches, never task-supplied commands. */
export async function importJobDeliveries(o: { homes: Homes; run: ProjectJobRun; workspace: string; repo: string; git: ThreadGit; gitEnv: Record<string, string>; library?: ProjectLibrary | undefined; redactor: SecretRedactor }) {
  const file = join(o.workspace, 'project-job-deliveries.json'); if (!existsSync(file)) return [];
  if (readFileSync(file).length > 512 * 1024) throw new Error('The job delivery manifest exceeds its limit.');
  const manifest = JobDeliveriesSchema.parse(o.redactor.document(readDocument(file, JobDeliveriesSchema))), receipts = [];
  if (new Set(manifest.deliveries.map(row => row.id)).size !== manifest.deliveries.length) throw new Error('Job delivery identities must be unique.');
  for (const delivery of manifest.deliveries) {
    const gate = o.run.spec.kind === 'command' ? o.run.spec.deliveryGate : undefined;
    if (gate && !delivery.gateInput) throw new Error('This job requires a private gate input for every delivery.');
    if (!gate && delivery.gateInput) throw new Error('This job has no configured delivery gate.');
    if (delivery.gateInput) {
      const data = await bytes(o.workspace, delivery.gateInput.ref, delivery.gateInput.sha256, 2 * 1024 * 1024);
      writeDocument(join(deliveryDirectory(o.homes, o.run.projectId, o.run.id), `${delivery.id}.json`), PrivateJobDeliverySchema, { schema: 'private-job-delivery-v1', runId: o.run.id, deliveryId: delivery.id, trustedCommit: o.run.commit, sha256: delivery.gateInput.sha256, input: JSON.parse(data.toString('utf8')) });
    }
    const attachments = [];
    for (const [index, artifact] of delivery.files.entries()) {
      if (!o.library?.addJob) throw new Error('Job artifact publication is unavailable.');
      await bytes(o.workspace, artifact.ref, artifact.sha256, 50 * 1024 * 1024);
      const item = await o.library.addJob(o.run.projectId, o.run.id, `${delivery.id}_${index}`, o.workspace, { path: artifact.ref, name: artifact.name });
      if (item.sha256 !== artifact.sha256) throw new Error('The uploaded job artifact changed.');
      attachments.push(`Attached file: library/${item.path}`);
    }
    const branch = `jevellan/jobs/${o.run.id}/${delivery.id}`, ref = `refs/heads/${branch}`;
    if (branch.length > 200) throw new Error('The job delivery branch exceeds its limit.');
    const remote = (await o.git.run(o.repo, ['ls-remote', '--heads', 'origin', ref], { env: o.gitEnv })).stdout.trim().split(/\s/u)[0];
    if (remote && remote !== o.run.commit) throw new Error('This job delivery branch already has different content.');
    if (!remote) await o.git.run(o.repo, ['push', 'origin', `${o.run.commit}:${ref}`, `--force-with-lease=${ref}:`], { env: o.gitEnv });
    receipts.push(JobDeliveryReceiptSchema.parse({ schema: 'project-job-delivery-v1', id: delivery.id, title: delivery.title, type: delivery.type, fromBranch: branch, brief: [delivery.brief, ...attachments].join('\n\n'), ...(gate ? { gate, inputSha256: delivery.gateInput!.sha256 } : {}) }));
  }
  return receipts;
}
