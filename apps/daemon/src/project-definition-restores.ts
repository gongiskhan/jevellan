import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { IdSchema, ProjectDefinitionSaveSchema, ProjectViewSchema, readDocument, stableJson, writeDocument, type Homes } from '@jevellan/core';
const ReceiptSchema = z.strictObject({ schema: z.literal('project-definition-restore-receipt-v1'), requestId: IdSchema, projectId: IdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['started', 'completed']) });
type Input = z.infer<typeof ProjectDefinitionSaveSchema>;
type View = z.infer<typeof ProjectViewSchema>;
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
/** The optional multi-step restore must never be replayed over work saved after it. */
export class ProjectDefinitionRestores {
  readonly #pending = new Map<string, { fingerprint: string; promise: Promise<View> }>();
  constructor(readonly homes: Homes) {}
  async run(raw: Input, required: boolean, perform: () => Promise<View>, current: () => Promise<View | null>): Promise<View> {
    const input = ProjectDefinitionSaveSchema.parse(raw), requestId = input.clientRequestId;
    const fingerprint = createHash('sha256').update(stableJson(input)).digest('hex');
    const different = () => conflict('This project save request was already used for different settings. Reopen the project before saving.');
    const pending = this.#pending.get(requestId);
    if (pending) { if (pending.fingerprint !== fingerprint) throw different(); return pending.promise; }
    const path = this.homes.at('project-definition-restores', `${requestId}.json`);
    if (existsSync(path)) {
      const receipt = readDocument(path, ReceiptSchema);
      if (receipt.requestId !== requestId || receipt.projectId !== input.context.projectId || receipt.fingerprint !== fingerprint) throw different();
      if (receipt.state !== 'completed') throw conflict('Vault restoration was interrupted. Reload Projects and inspect the saved work before restoring again.');
      const saved = await current(); if (!saved) throw conflict('This project was removed after saving. Refresh the list.');
      return saved;
    }
    if (!required) return perform();
    const receipt = ReceiptSchema.parse({ schema: 'project-definition-restore-receipt-v1', requestId, projectId: input.context.projectId, fingerprint, state: 'started' });
    writeDocument(path, ReceiptSchema, receipt);
    const promise = Promise.resolve().then(perform).then(result => { writeDocument(path, ReceiptSchema, { ...receipt, state: 'completed' }); return result; }).finally(() => { this.#pending.delete(requestId); });
    this.#pending.set(requestId, { fingerprint, promise });
    return promise;
  }
}
