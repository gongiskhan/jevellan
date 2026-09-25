import { spawnSync } from 'node:child_process';
import { constants, accessSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { atomicWrite, readDocument, writeDocument } from './files.js';
import { type Homes } from './homes.js';
import { IdSchema } from './schemas.js';

const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const pair = z.strictObject({ before: commit, after: commit });
export const GitRewritePlanSchema = z.strictObject({
  schema: z.literal('git-rewrite-plan-v1'), id: IdSchema, workId: IdSchema,
  before: commit, base: commit, upstream: commit, commits: z.array(commit), savedRef: z.string().min(1),
});
export type GitRewritePlan = z.infer<typeof GitRewritePlanSchema>;
export const GitRewriteEventSchema = z.strictObject({ schema: z.literal('git-rewrite-event-v1'), id: IdSchema, kind: z.literal('rebase'), pairs: z.array(pair) });
export const GitRewriteReceiptSchema = z.strictObject({
  schema: z.literal('git-rewrite-receipt-v1'), plan: GitRewritePlanSchema, after: commit, pairs: z.array(pair),
});
export type GitRewriteReceipt = z.infer<typeof GitRewriteReceiptSchema>;
export const GitRewriteAbortedSchema = z.strictObject({ schema: z.literal('git-rewrite-aborted-v1'), plan: GitRewritePlanSchema });
const manifestSchema = z.strictObject({ schema: z.literal('git-rewrite-capture-v1'), plan: GitRewritePlanSchema, originalHooks: z.string().min(1) });
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

/** Scoped Git options preserve native hooks without editing any Git configuration. */
export class GitRewriteCapture {
  readonly options: string[];
  private constructor(readonly directory: string, readonly plan: GitRewritePlan) {
    this.options = ['-c', `core.hooksPath=${join(directory, 'hooks')}`];
  }
  static create(homes: Homes, plan: GitRewritePlan, originalHooks: string): GitRewriteCapture {
    GitRewritePlanSchema.parse(plan);
    const directory = homes.at('integrations', plan.id);
    if (existsSync(directory)) throw new Error('This integration capture already exists. Recover its recorded result before retrying.');
    homes.ensure('integrations'); mkdirSync(directory, { mode: 0o700 });
    const hooks = join(directory, 'hooks'); mkdirSync(hooks, { mode: 0o700 });
    writeDocument(join(directory, 'manifest.json'), manifestSchema, { schema: 'git-rewrite-capture-v1', plan, originalHooks });
    // Forward using the original executable path, preserving hooks that depend on $0.
    for (const name of existsSync(originalHooks) ? readdirSync(originalHooks) : []) {
      const original = join(originalHooks, name);
      if (name !== 'post-rewrite' && executable(original)) writeFileSync(join(hooks, name), `#!/bin/sh\nexec ${quote(original)} "$@"\n`, { mode: 0o700 });
    }
    writeFileSync(join(hooks, 'post-rewrite'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} ${quote(directory)} "$@"\n`, { mode: 0o700 });
    return new GitRewriteCapture(directory, plan);
  }
  static recover(homes: Homes, id: string): GitRewriteCapture {
    const directory = homes.at('integrations', IdSchema.parse(id));
    const manifest = readDocument(join(directory, 'manifest.json'), manifestSchema);
    if (manifest.plan.id !== id) throw new Error('Integration capture belongs to another operation.');
    return new GitRewriteCapture(directory, manifest.plan);
  }
  pairs(): z.infer<typeof pair>[] | undefined {
    const path = join(this.directory, 'rewrites.json');
    if (!existsSync(path)) return undefined;
    const event = readDocument(path, GitRewriteEventSchema);
    if (event.id !== this.plan.id) throw new Error('Git rewrite records belong to another integration.');
    return event.pairs;
  }
}

/** Git ignores post-rewrite exit status, so callers also require a validated receipt. */
function postRewrite(directory: string, args: string[]): number {
  const manifest = readDocument(join(directory, 'manifest.json'), manifestSchema);
  const input = readFileSync(0); let failure = false;
  try {
    if (args[0] === 'rebase') {
      const pairs = input.toString('utf8').trim().split('\n').filter(Boolean).map((line) => {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 2) throw new Error('Incomplete Git rewrite pair.');
        return { before: fields[0], after: fields[1] };
      });
      const event = GitRewriteEventSchema.parse({ schema: 'git-rewrite-event-v1', id: manifest.plan.id, kind: 'rebase', pairs });
      const path = join(directory, 'rewrites.json');
      if (existsSync(path)) throw new Error('This integration already recorded a rewrite.');
      atomicWrite(path, JSON.stringify(event) + '\n');
    }
  } catch { process.stderr.write('Jevellan could not record this Git rewrite. Publication requires reconciliation.\n'); failure = true; }
  const original = join(manifest.originalHooks, 'post-rewrite');
  const delegated = executable(original) ? spawnSync(original, args, { input, stdio: ['pipe', 'inherit', 'inherit'] }) : undefined;
  return failure ? 1 : delegated?.status ?? (delegated?.error || delegated?.signal ? 1 : 0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = postRewrite(process.argv[2]!, process.argv.slice(3)); }
  catch { process.stderr.write('Jevellan Git rewrite capture could not start.\n'); process.exitCode = 1; }
}
