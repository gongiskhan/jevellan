import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { GitCheckpointPlanSchema, GitConflictSchema, GitConflictResolutionSchema, GitSnapshotSchema, GitUndoPlanSchema, GitUndoRecoverySchema, GitUndoResultSchema, IdSchema, type Action, type GitCheckpointPlan, type GitConflict, type GitConflictResolution, type GitSnapshot, type GitUndoPlan, type GitUndoResult, type Project } from './schemas.js';
import { inside, resolvedPath, resolveProjectPath, type Homes } from './homes.js';
import { GitRewriteCapture, GitRewritePlanSchema, GitRewriteReceiptSchema, type GitRewriteReceipt } from './git-rewrite.js';
import { atomicWrite } from './files.js';
import { SecretRedactor } from './environment.js';
import { runOwnedCommand, type CommandResult } from './command.js';
import { GitSettings, gitFailureMessage } from './git-settings.js';
import type { CheckoutOwner, CheckoutOwnership } from './locks.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class GitWorkspace {
  constructor(readonly project: Project, readonly deviceId: string, readonly ownership: CheckoutOwnership, readonly owner: CheckoutOwner, readonly redactor = new SecretRedactor()) {}
  get path(): string { return resolveProjectPath(this.project, this.deviceId); }
  async #git(args: string[], permittedFailures: number[] = [], input?: string): Promise<CommandResult> {
    const result = await runOwnedCommand('git', ['--no-pager', ...args], { cwd: this.path, env: new GitSettings(this.ownership.homes).environment(), redactOutput: false, ...(input === undefined ? {} : { input }) });
    if (result.timedOut || (result.code !== 0 && !permittedFailures.includes(result.code))) throw new Error(`Git ${args[0]} failed (${result.code}): ${gitFailureMessage(result.stderr.trim(), this.redactor)}`);
    return result;
  }
  async head(): Promise<string> { return (await this.#git(['rev-parse', 'HEAD'])).stdout.trim(); }
  async clean(): Promise<boolean> { return !(await this.#git(['status', '--porcelain=v1', '-z'])).stdout; }
  async workingTreeDigest(): Promise<string> {
    // Staging a deletion must not erase that reviewed path from the fingerprint.
    const listed = await Promise.all([this.#git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']), this.#git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])]);
    const names = [...new Set(listed.flatMap(result => result.stdout.split('\0').filter(Boolean)))].sort();
    const digest = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024);
    for (const name of names) {
      const path = resolve(this.path, name); digest.update(`${name}\0`);
      let stat;
      try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!stat) { digest.update('missing\0'); continue; }
      digest.update(`${stat.mode & 0o777}\0`);
      if (stat.isSymbolicLink()) digest.update(`link:${readlinkSync(path)}\0`);
      else if (stat.isFile()) {
        const content = createHash('sha256'); const fd = openSync(path, 'r');
        try { for (;;) { const length = readSync(fd, buffer, 0, buffer.length, null); if (!length) break; content.update(buffer.subarray(0, length)); } }
        finally { closeSync(fd); }
        digest.update(content.digest());
      } else throw new Error('Worktree verification requires regular files; nested submodule worktrees are not supported.');
    }
    return digest.digest('hex');
  }
  async branch(): Promise<string> { return (await this.#git(['symbolic-ref', '--quiet', 'HEAD'], [1])).stdout.trim() || '(detached)'; }
  async #main(): Promise<void> { if (await this.branch() !== 'refs/heads/main') throw new Error('This project must be on main before Jevellan can change git.'); }
  async #write(): Promise<void> {
    if (this.project.branchPolicy !== 'main') throw new Error('This project follows its own git rules. Jevellan will not change git.');
    await this.ownership.assert(this.project, this.owner); await this.#main();
  }
  async remote(): Promise<string> {
    const remote = (await this.#git(['remote', 'get-url', 'origin'])).stdout.trim();
    if (this.redactor.text(remote) !== remote) throw new Error('Use a credential helper instead of credentials in the project remote URL.');
    if (/^https?:\/\//.test(remote)) {
      const url = new URL(remote);
      if (url.username || url.password) throw new Error('Use a credential helper instead of credentials in the project remote URL.');
    }
    return remote;
  }
  async remoteHead(): Promise<string | null> {
    const names = (await this.#git(['remote'])).stdout.trim().split('\n');
    if (!names.includes('origin')) return null;
    await this.remote();
    return (await this.#git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], [2])).stdout.split(/\s/)[0] || null;
  }
  async snapshot(): Promise<GitSnapshot> {
    const [head, branch, clean, refs, remotes, remoteHead] = await Promise.all([
      this.head(), this.branch(), this.clean(), this.#git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes']),
      this.#git(['config', '--local', '--get-regexp', '^remote[.]'], [1]), this.remoteHead(),
    ]);
    return GitSnapshotSchema.parse({ schema: 'git-snapshot-v1', head, branch: this.redactor.text(branch), clean, refsDigest: hash(refs.stdout), otherRefsDigest: hash(refs.stdout.split('\n').filter((line) => !line.startsWith('refs/heads/main ')).join('\n')), remotesDigest: hash(remotes.stdout), remoteHead });
  }
  async checkAfterStretch(before: GitSnapshot, action: Action): Promise<GitSnapshot> {
    const after = await this.snapshot();
    const changed = before.branch !== after.branch || before.remotesDigest !== after.remotesDigest || before.remoteHead !== after.remoteHead
      || (action === 'integrate' ? before.otherRefsDigest !== after.otherRefsDigest : before.refsDigest !== after.refsDigest);
    if (changed) throw new Error('An agent changed git history or remotes directly. Jevellan has not published anything from this work.');
    return after;
  }
  async prepare(): Promise<string> {
    if (this.project.branchPolicy === 'external') { await this.ownership.assert(this.project, this.owner); return this.head(); }
    await this.#write();
    const blocked = () => new Error(`${this.project.name} on ${this.deviceId} has changes that don't belong to this conversation. Commit, stash or publish them, then press Retry.`);
    if (!await this.clean()) throw blocked();
    const before = await this.head();
    await this.#git(['fetch', 'origin']);
    await this.ownership.assert(this.project, this.owner);
    if (!await this.clean() || await this.head() !== before) throw blocked();
    const behind = await this.#git(['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], [1]);
    if (behind.code !== 0) throw blocked();
    await this.#git(['merge', '--ff-only', 'refs/remotes/origin/main']);
    return this.head();
  }
  async checkpoint(action: Action | 'memory' | 'context', summary: string, before: GitSnapshot, assertCurrent?: () => void | Promise<void>): Promise<{ head: string; committed: boolean }> {
    if (!['implement', 'test', 'integrate', 'memory', 'context'].includes(action)) throw new Error('Read-only actions cannot create checkpoints.');
    await this.#write(); await assertCurrent?.();
    await this.checkAfterStretch(before, action === 'memory' || action === 'context' ? 'implement' : action);
    if (!await this.clean()) {
      const subject = `${action}: ${summary.split(/\r?\n/)[0] ?? 'Checkpoint'}`.slice(0, 72);
      await assertCurrent?.(); await this.#git(['add', '-A']); await this.ownership.assert(this.project, this.owner); await assertCurrent?.();
      await this.#git(['commit', '-m', subject]); return { head: await this.head(), committed: true };
    }
    return { head: await this.head(), committed: false };
  }
  async diff(before: string, after?: string): Promise<string> {
    if (!/^[a-f0-9]{40,64}$/.test(before) || (after && !/^[a-f0-9]{40,64}$/.test(after))) throw new Error('Diff requires exact commit ids.');
    return this.redactor.text((await this.#git(['diff', '--no-ext-diff', '--no-textconv', before, ...(after ? [after] : []), '--'])).stdout);
  }
  async uncommittedDiff(): Promise<string> {
    let diff = await this.diff(await this.head());
    const names = (await this.#git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
    for (const name of names) diff += this.redactor.text((await this.#git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', name], [1])).stdout);
    return diff;
  }
  async changedFiles(before?: string, after?: string): Promise<string[]> {
    if ((before && !/^[a-f0-9]{40,64}$/.test(before)) || (after && !/^[a-f0-9]{40,64}$/.test(after))) throw new Error('File lists require exact commit ids.');
    const tracked = (await this.#git(['diff', '--name-only', '--no-renames', '-z', before ?? 'HEAD', ...(after ? [after] : []), '--'])).stdout;
    const untracked = after ? '' : (await this.#git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
    return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))];
  }
  async checkpointBoundary(before: GitSnapshot): Promise<GitSnapshot> {
    await this.#main();
    if (await this.#operationInProgress()) throw new Error('Finish or abort the pending Git operation before accepting these changes.');
    const current = await this.checkAfterStretch(before, 'implement');
    if (current.head !== before.head) throw new Error('Git history changed. Reconcile it before accepting these files.');
    return current;
  }
  #checkpointRef(id: string): string { return `refs/jevellan/checkpoints/${IdSchema.parse(this.owner.conversationId)}/${IdSchema.parse(id)}`; }
  /** Prepare an exact checkpoint before its intent is recorded; never move main here. */
  async planCheckpoint(id: string, before: GitSnapshot, worktreeDigest: string, assertCurrent: () => void | Promise<void>): Promise<GitCheckpointPlan> {
    await this.#write();
    const unchanged = async () => {
      await this.ownership.assert(this.project, this.owner); await assertCurrent();
      await this.checkpointBoundary(before);
      if (await this.workingTreeDigest() !== worktreeDigest) throw new Error('The files changed since you reviewed them. Open Changes again before continuing.');
    };
    await unchanged(); await this.#git(['add', '-A']); await unchanged();
    const tree = (await this.#git(['write-tree'])).stdout.trim();
    const previousTree = (await this.#git(['rev-parse', `${before.head}^{tree}`])).stdout.trim();
    const after = tree === previousTree ? before.head : (await this.#git(['commit-tree', tree, '-p', before.head, '-m', 'implement: Accept reviewed changes'])).stdout.trim();
    await unchanged();
    await this.#git(['update-ref', this.#checkpointRef(id), after, '0'.repeat(after.length)]);
    return GitCheckpointPlanSchema.parse({ schema: 'git-checkpoint-plan-v1', id, before, worktreeDigest, tree, after });
  }
  async #validateCheckpoint(raw: GitCheckpointPlan): Promise<GitCheckpointPlan> {
    const plan = GitCheckpointPlanSchema.parse(raw);
    const saved = (await this.#git(['rev-parse', '--verify', this.#checkpointRef(plan.id)])).stdout.trim();
    const actual = (await this.#git(['show', '-s', '--format=%P%n%T', plan.after])).stdout.trimEnd().split('\n');
    if (saved !== plan.after || actual[1] !== plan.tree || plan.after !== plan.before.head && actual[0] !== plan.before.head) throw new Error('The saved checkpoint does not match its recorded plan.');
    return plan;
  }
  async checkpointApplied(raw: GitCheckpointPlan): Promise<boolean> {
    const plan = await this.#validateCheckpoint(raw); const snapshot = await this.snapshot();
    return snapshot.branch === 'refs/heads/main' && snapshot.head === plan.after && snapshot.otherRefsDigest === plan.before.otherRefsDigest
      && snapshot.remotesDigest === plan.before.remotesDigest && !await this.#operationInProgress();
  }
  async applyCheckpoint(raw: GitCheckpointPlan, assertCurrent: () => void | Promise<void>): Promise<void> {
    await this.#write(); const plan = await this.#validateCheckpoint(raw);
    await this.ownership.assert(this.project, this.owner); await assertCurrent();
    await this.checkpointBoundary(plan.before);
    const tree = (await this.#git(['write-tree'])).stdout.trim();
    if (tree !== plan.tree || await this.workingTreeDigest() !== plan.worktreeDigest) throw new Error('The files changed since you reviewed them. Open Changes again before continuing.');
    // Compare-and-swap changes only the branch pointer. The reviewed index and files stay intact.
    if (plan.after !== plan.before.head) await this.#git(['update-ref', '-m', 'Jevellan: accept reviewed changes', 'refs/heads/main', plan.after, plan.before.head]);
    if (!await this.checkpointApplied(plan)) throw new Error('The checkout changed while accepting these files. Its recorded checkpoint is preserved.');
  }
  async changeFacts(base: string): Promise<{ changeSize: 'small' | 'medium' | 'large'; riskyAreasTouched: string[] }> {
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Change facts require an exact base commit.');
    const diff = await this.diff(base);
    const files = (await this.#git(['diff', '--name-only', '-z', base, '--'])).stdout.split('\0').filter(Boolean);
    const size = Buffer.byteLength(diff);
    const patterns = { migrations: /migrat/i, auth: /auth|login|credential/i, payments: /pay|billing/i, deletion: /delete|remove/i, locks: /lock/i, queues: /queue/i };
    return { changeSize: files.length < 3 && size < 4096 ? 'small' : files.length > 12 || size > 40 * 1024 ? 'large' : 'medium', riskyAreasTouched: Object.entries(patterns).filter(([, pattern]) => files.some((path) => pattern.test(path))).map(([area]) => area) };
  }
  async changedPaths(before: string, after = 'HEAD'): Promise<string[]> {
    if (!/^[a-f0-9]{40,64}$/.test(before) || after !== 'HEAD' && !/^[a-f0-9]{40,64}$/.test(after)) throw new Error('Changed paths require exact commit ids.');
    return (await this.#git(['diff', '--no-renames', '--name-only', '-z', before, after, '--'])).stdout.split('\0').filter(Boolean);
  }
  async saveRef(kind: 'undo' | 'pre-integration' | 'discard', n: number): Promise<string> {
    await this.#write(); IdSchema.parse(this.owner.conversationId);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid saved-ref step.');
    const ref = `refs/jevellan/${kind}/${this.owner.conversationId}/${n}`;
    const head = await this.head(); await this.#git(['update-ref', ref, head, '0'.repeat(head.length)]); return ref;
  }
  async publicationKey(): Promise<string> {
    const remote = await this.remote();
    if (remote.startsWith('file://')) return `file:${realpathSync(new URL(remote))}`;
    if (isAbsolute(remote) || remote.startsWith('.')) return `file:${realpathSync(resolve(this.path, remote))}`;
    const github = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/.exec(remote);
    return github ? `github.com/${github[1]!.replace(/\.git$/, '').toLowerCase()}` : remote;
  }
  async #undoCommits(target: string, sourceTip: string): Promise<string[]> {
    if (![target, sourceTip].every((commit) => /^[a-f0-9]{40,64}$/.test(commit))) throw new Error('Undo requires exact commit ids.');
    if ((await this.#git(['merge-base', '--is-ancestor', target, sourceTip], [1])).code !== 0) throw new Error('The undo target is not in the recorded checkpoint history.');
    if ((await this.#git(['rev-list', '--min-parents=2', `${target}..${sourceTip}`])).stdout.trim()) throw new Error('Undo requires the recorded linear checkpoint history, without merge commits.');
    return (await this.#git(['rev-list', `${target}..${sourceTip}`])).stdout.trim().split('\n').filter(Boolean);
  }
  async #operationInProgress(): Promise<boolean> {
    const directory = (await this.#git(['rev-parse', '--absolute-git-dir'])).stdout.trim();
    return ['rebase-merge', 'rebase-apply', 'sequencer', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((name) => existsSync(resolve(directory, name)));
  }
  async #plannedUndoCommits(input: Pick<GitUndoPlan, 'target' | 'sourceTip' | 'ranges'>): Promise<string[]> {
    if (!input.ranges) return this.#undoCommits(input.target, input.sourceTip);
    if (input.ranges[0]?.before !== input.target || input.ranges.at(-1)?.after !== input.sourceTip) throw new Error('Undo ranges do not match their recorded boundaries.');
    const commits: string[] = [];
    for (const range of [...input.ranges].reverse()) commits.push(...await this.#undoCommits(range.before, range.after));
    if (new Set(commits).size !== commits.length) throw new Error('Undo ranges contain the same checkpoint more than once.');
    return commits;
  }
  #continuousUndoHistory(input: Pick<GitUndoPlan, 'target' | 'ranges'>): boolean {
    return !input.ranges || input.ranges.every((range, index) => range.before === (index ? input.ranges![index - 1]!.after : input.target));
  }
  async #revertTree(head: string, commit: string): Promise<string> {
    const parent = (await this.#git(['rev-parse', `${commit}^`])).stdout.trim();
    const merge = await this.#git(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${commit}`, head, parent], [1]);
    if (merge.code !== 0) throw new Error('Undo conflicts with newer changes. The checkout has not changed.');
    const tree = merge.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error('Git did not return a complete undo tree.');
    return tree;
  }
  async #prepareReverts(before: string, commits: string[]): Promise<string> {
    let head = before;
    for (const commit of commits) {
      const tree = await this.#revertTree(head, commit);
      const subject = (await this.#git(['show', '-s', '--format=%s', commit])).stdout.trim();
      head = (await this.#git(['commit-tree', tree, '-p', head, '-m', `Revert "${subject}"`, '-m', `This reverts commit ${commit}.`])).stdout.trim();
    }
    // Retain the prepared objects even if a crash occurs before the ledger is written.
    const ref = `refs/jevellan/undo-results/${this.owner.conversationId}/${head}`;
    const previous = (await this.#git(['rev-parse', '--verify', ref], [128])).stdout.trim();
    if (!previous) await this.#git(['update-ref', ref, head, '0'.repeat(head.length)]);
    else if (previous !== head) throw new Error('Prepared undo ref has changed.');
    return head;
  }
  async #validateUndo(plan: GitUndoPlan): Promise<void> {
    IdSchema.parse(this.owner.conversationId);
    if (plan.savedRef !== `refs/jevellan/undo/${this.owner.conversationId}/${plan.step}`) throw new Error('Undo recovery ref belongs to another operation.');
    const commits = await this.#plannedUndoCommits(plan);
    if (commits.join('\n') !== plan.commits.join('\n') || (plan.mode === 'unchanged') !== !commits.length) throw new Error('Undo plan does not match its recorded checkpoint history.');
    if (plan.mode === 'reset' && (plan.before !== plan.sourceTip || plan.resultCommit && plan.resultCommit !== plan.target)) throw new Error('Unpublished undo must start at its recorded checkpoint tip.');
    if (plan.mode === 'reset' && !this.#continuousUndoHistory(plan)) throw new Error('Unpublished undo cannot skip checkpoint history.');
    if (plan.mode === 'unchanged' && plan.resultCommit && plan.resultCommit !== plan.before) throw new Error('An unchanged undo cannot move HEAD.');
    if (plan.mode === 'revert' && plan.resultCommit) {
      const prepared = (await this.#git(['rev-list', '--reverse', `${plan.before}..${plan.resultCommit}`])).stdout.trim().split('\n').filter(Boolean);
      if (prepared.length !== commits.length) throw new Error('Prepared undo does not match its checkpoint count.');
      let parent = plan.before;
      for (let index = 0; index < prepared.length; index++) {
        const commit = prepared[index]!; const source = commits[index]!;
        const expected = await this.#revertTree(parent, source);
        const actual = (await this.#git(['show', '-s', '--format=%P%n%T%n%B', commit])).stdout;
        if (!actual.startsWith(`${parent}\n${expected}\n`) || !actual.includes(`\nThis reverts commit ${source}.\n`)) throw new Error('Prepared undo commit does not match its recorded change.');
        parent = commit;
      }
    }
  }
  /** Inspection never moves HEAD, updates refs, edits files, or starts another Git operation. */
  async inspectUndo(raw: GitUndoPlan) {
    const plan = GitUndoPlanSchema.parse(raw);
    IdSchema.parse(this.owner.conversationId);
    if (plan.savedRef !== `refs/jevellan/undo/${this.owner.conversationId}/${plan.step}`) throw new Error('Undo recovery ref belongs to another operation.');
    const blocked = (reason: string) => GitUndoRecoverySchema.parse({ schema: 'git-undo-recovery-v1', status: 'blocked', reason });
    if (await this.branch() !== 'refs/heads/main' || await this.#operationInProgress() || !await this.clean()) return blocked('Undo recovery requires a clean main checkout with no Git operation in progress. Inspect its changes first.');
    const saved = (await this.#git(['rev-parse', '--verify', plan.savedRef], [128])).stdout.trim();
    if (saved && saved !== plan.before) return blocked('The undo recovery ref preserves a different checkpoint.');
    const head = await this.head(); const expected = plan.resultCommit ?? (plan.mode === 'reset' ? plan.target : plan.mode === 'unchanged' ? plan.before : undefined);
    if (saved && expected && head === expected) return GitUndoRecoverySchema.parse({ schema: 'git-undo-recovery-v1', status: 'completed', result: { schema: 'git-undo-result-v1', plan, after: head } });
    if (head === plan.before) return GitUndoRecoverySchema.parse({ schema: 'git-undo-recovery-v1', status: 'ready' });
    return blocked('The checkout changed since undo was prepared. Inspect the saved recovery ref before retrying.');
  }
  /** sourceTip is the recorded checkpoint tip before publication rebases, never a guessed remote range. */
  async planUndo(input: Pick<GitUndoPlan, 'target' | 'sourceTip' | 'ranges'> & { step: number; published: boolean }): Promise<GitUndoPlan> {
    await this.#write(); IdSchema.parse(this.owner.conversationId);
    if (!Number.isSafeInteger(input.step) || input.step < 1) throw new Error('Invalid undo step.');
    if (!await this.clean() || await this.#operationInProgress()) throw new Error('Undo requires a clean, settled checkpoint with no Git operation in progress.');
    const before = await this.head(); const commits = await this.#plannedUndoCommits(input);
    await this.fetch();
    let published = input.published;
    for (const commit of commits) if ((await this.#git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'], [1])).code === 0) published = true;
    if (!published && !this.#continuousUndoHistory(input)) throw new Error('Unpublished undo cannot skip checkpoint history.');
    if (!published && before !== input.sourceTip) throw new Error('The checkout no longer matches the recorded checkpoint tip.');
    if (await this.head() !== before || !await this.clean() || await this.#operationInProgress()) throw new Error('The checkout changed while preparing undo.');
    const mode = !commits.length ? 'unchanged' : published ? 'revert' : 'reset';
    const resultCommit = mode === 'revert' ? await this.#prepareReverts(before, commits) : mode === 'reset' ? input.target : before;
    return GitUndoPlanSchema.parse({ schema: 'git-undo-plan-v1', mode, step: input.step, before, target: input.target, sourceTip: input.sourceTip, commits, resultCommit, ...(input.ranges ? { ranges: input.ranges } : {}), savedRef: `refs/jevellan/undo/${this.owner.conversationId}/${input.step}` });
  }
  /** Persist the plan in recordSaved before mutating HEAD; a different existing backup is never replaced. */
  async applyUndo(raw: GitUndoPlan, assertCurrent: () => void | Promise<void>, recordSaved: (plan: GitUndoPlan) => void): Promise<GitUndoResult> {
    const plan = GitUndoPlanSchema.parse(raw); await this.#write();
    await this.#validateUndo(plan); const commits = plan.commits;
    const saved = (await this.#git(['rev-parse', '--verify', plan.savedRef], [128])).stdout.trim();
    if (saved && saved !== plan.before) throw new Error('This undo recovery ref already preserves a different checkpoint.');
    if (!await this.clean() || await this.#operationInProgress()) throw new Error('Undo requires a clean, settled checkpoint with no Git operation in progress.');
    const head = await this.head();
    if (saved && head === (plan.resultCommit ?? (plan.mode === 'reset' ? plan.target : undefined))) return GitUndoResultSchema.parse({ schema: 'git-undo-result-v1', plan, after: head });
    if (head !== plan.before) throw new Error('The checkout changed since undo was prepared. Inspect the saved recovery ref before retrying.');
    if (plan.mode === 'reset') {
      await this.fetch();
      for (const commit of commits) if ((await this.#git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'], [1])).code === 0) throw new Error('A checkpoint was published after undo was prepared. Prepare revert-based undo instead.');
    }
    await assertCurrent();
    if (await this.head() !== plan.before || !await this.clean()) throw new Error('The checkout changed before undo.');
    if (!saved) await this.#git(['update-ref', plan.savedRef, plan.before, '0'.repeat(plan.before.length)]);
    recordSaved(plan); await this.#write(); await assertCurrent();
    if (await this.head() !== plan.before || !await this.clean() || await this.#operationInProgress()) throw new Error('The checkout changed after its undo recovery ref was saved.');
    if (plan.mode === 'reset') await this.#git(['reset', '--hard', plan.target]);
    else if (plan.mode === 'revert' && plan.resultCommit) await this.#git(['merge', '--ff-only', '--no-edit', plan.resultCommit]);
    else if (plan.mode === 'revert') {
      const reverted = await this.#git(['revert', '--no-edit', ...commits], [1]);
      if (reverted.code !== 0) {
        await this.#git(['revert', '--abort'], [128]);
        if (await this.head() !== plan.before || !await this.clean() || await this.#operationInProgress()) throw new Error(`Undo could not finish cleanly. Checkout ownership remains held; recovery ref: ${plan.savedRef}.`);
        throw new Error(`Undo conflicts with newer changes. The original checkout was restored; recovery ref: ${plan.savedRef}.`);
      }
    }
    if (!await this.clean()) throw new Error('Undo left uncommitted files. Checkout ownership remains held.');
    const after = await this.head();
    if (plan.mode === 'reset' && after !== plan.target) throw new Error('Undo did not reach its recorded target.');
    if (plan.resultCommit && after !== plan.resultCommit) throw new Error('Undo did not reach its prepared result.');
    return GitUndoResultSchema.parse({ schema: 'git-undo-result-v1', plan, after });
  }
  /** Discard only clean, unpublished checkpoints; preserve the complete old tip first. */
  async discard(base: string, expectedHead: string, n: number, assertCurrent: () => void | Promise<void>, recordSaved: (ref: string) => void = () => undefined, resumeRef?: string): Promise<string> {
    if (![base, expectedHead].every((commit) => /^[a-f0-9]{40,64}$/.test(commit))) throw new Error('Discard requires exact commit ids.');
    await this.#write();
    if (await this.#operationInProgress()) throw new Error('Discard requires a settled checkpoint with no Git operation in progress.');
    if (!await this.clean() || await this.head() !== expectedHead) throw new Error('The checkout changed. Inspect the changes before discarding.');
    if (!await this.contains(base)) throw new Error('The work base is no longer in this checkout history.');
    await this.fetch();
    const commits = (await this.#git(['rev-list', `${base}..${expectedHead}`])).stdout.trim().split('\n').filter(Boolean);
    for (const commit of commits) {
      if ((await this.#git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'], [1])).code === 0) throw new Error('Some of these checkpoints were already published. Use undo to create revert commits instead.');
    }
    await assertCurrent();
    if (!await this.clean() || await this.head() !== expectedHead) throw new Error('The checkout changed. Inspect the changes before discarding.');
    if (resumeRef !== undefined && (resumeRef !== `refs/jevellan/discard/${this.owner.conversationId}/${n}` || (await this.#git(['rev-parse', '--verify', resumeRef], [128])).stdout.trim() !== expectedHead)) throw new Error('The saved discard checkpoint changed. Inspect its recovery ref before continuing.');
    const savedRef = resumeRef ?? await this.saveRef('discard', n);
    recordSaved(savedRef);
    await this.#write(); await assertCurrent();
    if (!await this.clean() || await this.head() !== expectedHead || await this.#operationInProgress()) throw new Error('The checkout changed after its recovery ref was saved.');
    if ((await this.#git(['rev-parse', '--verify', savedRef], [128])).stdout.trim() !== expectedHead) throw new Error('The saved discard checkpoint changed. Inspect its recovery ref before continuing.');
    await this.#git(['reset', '--hard', base]);
    if (await this.head() !== base || !await this.clean()) throw new Error('Discard did not reach the work base cleanly. Checkout ownership remains held.');
    return savedRef;
  }
  /** Reconcile a lost discard result from its exact saved ref, without changing Git. */
  async discardApplied(base: string, before: string, savedRef: string): Promise<boolean> {
    const prefix = `refs/jevellan/discard/${this.owner.conversationId}/`;
    if (![base, before].every(commit => /^[a-f0-9]{40,64}$/.test(commit)) || !savedRef.startsWith(prefix) || !/^[1-9][0-9]*$/.test(savedRef.slice(prefix.length))) return false;
    if (await this.branch() !== 'refs/heads/main' || await this.#operationInProgress() || !await this.clean() || await this.head() !== base) return false;
    return (await this.#git(['rev-parse', '--verify', savedRef], [128])).stdout.trim() === before;
  }
  async fetch(): Promise<void> { await this.#write(); await this.#git(['fetch', 'origin']); }
  async upstream(): Promise<string> { return (await this.#git(['rev-parse', 'refs/remotes/origin/main'])).stdout.trim(); }
  async contains(commit: string): Promise<boolean> {
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Expected a commit id.');
    return (await this.#git(['merge-base', '--is-ancestor', commit, 'HEAD'], [1])).code === 0;
  }
  async prepareRebaseTracking(homes: Homes, id: string): Promise<GitRewriteCapture> {
    await this.#write(); IdSchema.parse(id);
    if (!await this.clean() || await this.#operationInProgress()) throw new Error('Integration tracking requires a clean, settled checkout.');
    const before = await this.head(); const upstream = await this.upstream();
    const base = (await this.#git(['merge-base', before, upstream])).stdout.trim();
    const commits = (await this.#undoCommits(base, before)).reverse();
    const savedRef = `refs/jevellan/integrations/${this.owner.conversationId}/${id}`;
    const plan = GitRewritePlanSchema.parse({ schema: 'git-rewrite-plan-v1', id, workId: this.owner.workId, before, upstream, base, commits, savedRef });
    const originalHooks = (await this.#git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])).stdout.trim();
    await this.ownership.assert(this.project, this.owner);
    if (await this.head() !== before || !await this.clean()) throw new Error('The checkout changed while preparing integration tracking.');
    await this.#git(['update-ref', savedRef, before, '0'.repeat(before.length)]);
    return GitRewriteCapture.create(homes, plan, originalHooks);
  }
  async #validateRebaseTracking(capture: GitRewriteCapture): Promise<void> {
    const plan = GitRewritePlanSchema.parse(capture.plan);
    if (plan.workId !== this.owner.workId || plan.savedRef !== `refs/jevellan/integrations/${this.owner.conversationId}/${plan.id}`) throw new Error('Integration tracking belongs to another work.');
    const saved = (await this.#git(['rev-parse', '--verify', plan.savedRef])).stdout.trim();
    if (saved !== plan.before || (await this.#undoCommits(plan.base, plan.before)).reverse().join('\n') !== plan.commits.join('\n')) throw new Error('Integration tracking no longer matches its saved checkpoints.');
  }
  /** Every destination is either the previous boundary (dropped) or its direct child. */
  async finishRebaseTracking(capture: GitRewriteCapture): Promise<GitRewriteReceipt> {
    await this.#write(); await this.#validateRebaseTracking(capture);
    if (await this.#operationInProgress() || !await this.clean()) throw new Error('Integration has not finished cleanly.');
    const plan = capture.plan; const after = await this.head();
    const recorded = capture.pairs();
    const pairs = recorded ?? (plan.base === plan.upstream && after === plan.before ? plan.commits.map((commit) => ({ before: commit, after: commit })) : !plan.commits.length && after === plan.upstream ? [] : undefined);
    if (!pairs || pairs.length !== plan.commits.length || pairs.some((pair, index) => pair.before !== plan.commits[index])) throw new Error('Git did not record a complete ordered mapping of the rebased checkpoints.');
    let boundary = plan.upstream;
    for (const pair of pairs) {
      if (pair.after !== boundary) {
        const parents = (await this.#git(['show', '-s', '--format=%P', pair.after])).stdout.trim();
        if (parents !== boundary) throw new Error('Git rewrite records do not describe a continuous integration onto the recorded upstream.');
      }
      boundary = pair.after;
    }
    if (boundary !== after) throw new Error('The checkout does not match the recorded integration result.');
    return GitRewriteReceiptSchema.parse({ schema: 'git-rewrite-receipt-v1', plan, after, pairs });
  }
  async integrationConflicts(): Promise<string[]> {
    return [...new Set((await this.#git(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean))];
  }
  async continueTrackedRebase(capture: GitRewriteCapture, command: 'continue' | 'skip', assertCurrent: () => void | Promise<void>): Promise<'clean' | 'conflict'> {
    if (this.project.branchPolicy !== 'main') throw new Error('This project follows its own git rules.');
    await this.ownership.assert(this.project, this.owner); await this.#validateRebaseTracking(capture);
    const directory = resolve(this.path, (await this.#git(['rev-parse', '--git-path', 'rebase-merge'])).stdout.trim());
    const metadata = (name: string) => readFileSync(resolve(directory, name), 'utf8').trim();
    if (metadata('head-name') !== 'refs/heads/main' || metadata('orig-head') !== capture.plan.before || metadata('onto') !== capture.plan.upstream) throw new Error('The in-progress rebase does not match this integration.');
    await assertCurrent();
    if (command === 'continue') {
      const paths = await this.integrationConflicts();
      if (paths.length) await this.#git(['--literal-pathspecs', 'add', '--', ...paths]);
    }
    await this.ownership.assert(this.project, this.owner); await assertCurrent();
    const result = await this.#git([...capture.options, '-c', 'core.editor=true', 'rebase', `--${command}`], [1]);
    if (result.code === 0) return 'clean';
    if (!await this.rebaseInProgress()) throw new Error('Rebase failed without a recoverable conflict.');
    return 'conflict';
  }
  async #conflictSides(raw: string): Promise<GitConflict[]> {
    const files = new Map<string, GitConflict>();
    for (const entry of raw.split('\0').filter(Boolean)) {
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([123])\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error('Git returned an invalid conflict index.');
      const mode = match[1]!; const oid = match[2]!; const stage = match[3]!; const path = match[4]!;
      let content: string | null = null;
      if (['100644', '100755'].includes(mode)) {
        const text = (await this.#git(['cat-file', 'blob', oid])).stdout;
        // Round-trip verification refuses binary or invalid UTF-8 instead of dropping bytes.
        if (!text.includes('\0') && (await this.#git(['hash-object', '--stdin'], [], text)).stdout.trim() === oid) content = text;
      }
      const conflict = files.get(path) ?? GitConflictSchema.parse({ schema: 'git-conflict-v1', path, base: null, upstream: null, local: null });
      conflict[stage === '1' ? 'base' : stage === '2' ? 'upstream' : 'local'] = { mode, oid, content }; files.set(path, conflict);
    }
    return [...files.values()].map((file) => GitConflictSchema.parse(file));
  }
  async rebase(options: { resolveConflicts?: (conflicts: GitConflict[]) => Promise<GitConflictResolution[] | null>; assertCurrent?: () => void | Promise<void>; tracking?: GitRewriteCapture } = {}): Promise<'clean' | 'conflict'> {
    await this.#write();
    if (!await this.clean()) throw new Error('Integration requires a clean checkpoint.');
    if (options.tracking) {
      await this.#validateRebaseTracking(options.tracking);
      if (await this.head() !== options.tracking.plan.before || await this.upstream() !== options.tracking.plan.upstream) throw new Error('Integration boundaries changed after their tracking plan was recorded.');
    }
    const scoped = options.tracking?.options ?? [];
    let result = await this.#git([...scoped, '-c', 'rebase.autoStash=false', 'rebase', '--merge', '--no-update-refs', '--no-fork-point', ...(options.tracking ? ['--reapply-cherry-picks'] : []), 'refs/remotes/origin/main'], [1]);
    while (result.code !== 0) {
      if (!await this.rebaseInProgress()) throw new Error('Rebase failed without a recoverable conflict.');
      if (!options.resolveConflicts) return 'conflict';
      const raw = (await this.#git(['ls-files', '--unmerged', '-z'])).stdout;
      if (!raw) return 'conflict';
      const conflicts = await this.#conflictSides(raw);
      if (conflicts.some((file) => [file.base, file.upstream, file.local].some((side) => side && (!['100644', '100755'].includes(side.mode) || side.content === null)))) return 'conflict';
      const head = await this.head(); const digest = await this.workingTreeDigest();
      const answers = await options.resolveConflicts(conflicts); if (!answers) return 'conflict';
      const resolutions = answers.map((answer) => GitConflictResolutionSchema.parse(answer));
      if (resolutions.length !== conflicts.length || new Set(resolutions.map((answer) => answer.path)).size !== conflicts.length || resolutions.some((answer) => !conflicts.some((file) => file.path === answer.path))) throw new Error('A conflict resolution must cover the exact unmerged paths.');
      await this.ownership.assert(this.project, this.owner); await options.assertCurrent?.();
      const branchFile = (await this.#git(['rev-parse', '--git-path', 'rebase-merge/head-name'])).stdout.trim();
      if (readFileSync(resolve(this.path, branchFile), 'utf8').trim() !== 'refs/heads/main' || await this.head() !== head || (await this.#git(['ls-files', '--unmerged', '-z'])).stdout !== raw || await this.workingTreeDigest() !== digest) throw new Error('The checkout changed while preparing memory conflict resolution.');
      for (const resolution of resolutions) {
        const path = resolve(this.path, resolution.path);
        if (!inside(this.path, path) || resolvedPath(path) !== path) throw new Error('Conflict paths must stay inside the checkout without symlinks.');
      }
      await options.assertCurrent?.();
      for (const resolution of resolutions) atomicWrite(resolve(this.path, resolution.path), resolution.content, Number.parseInt(resolution.mode, 8) & 0o777);
      await this.#git(['--literal-pathspecs', 'add', '--', ...resolutions.map((answer) => answer.path)]);
      await this.ownership.assert(this.project, this.owner); await options.assertCurrent?.();
      result = await this.#git([...scoped, '-c', 'core.editor=true', 'rebase', '--continue'], [1]);
    }
    return 'clean';
  }
  async rebaseInProgress(): Promise<boolean> {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const path = (await this.#git(['rev-parse', '--git-path', name])).stdout.trim();
      if (existsSync(resolve(this.path, path))) return true;
    }
    return false;
  }
  /** An abort boundary includes staged resolutions and Git's operation metadata. It never contacts the remote. */
  async rebaseFingerprint(): Promise<string> {
    const [head, branch, files, refs, index, remotes, original] = await Promise.all([
      this.head(), this.branch(), this.workingTreeDigest(), this.#git(['for-each-ref', '--format=%(refname) %(objectname)']),
      this.#git(['ls-files', '--stage', '-z']), this.#git(['config', '--local', '--get-regexp', '^remote[.]'], [1]),
      this.#git(['rev-parse', '--verify', 'ORIG_HEAD'], [128]),
    ]);
    const digest = createHash('sha256');
    for (const value of [head, branch, files, refs.stdout, index.stdout, remotes.stdout, original.stdout]) digest.update(`${Buffer.byteLength(value)}\0${value}`);
    const visit = (folder: string, prefix: string) => {
      for (const name of readdirSync(folder).sort()) {
        const path = resolve(folder, name); const entry = lstatSync(path); const relative = `${prefix}/${name}`;
        digest.update(`${relative}\0${entry.mode & 0o777}\0`);
        if (entry.isDirectory()) visit(path, relative);
        else if (entry.isFile()) digest.update(createHash('sha256').update(readFileSync(path)).digest());
        else throw new Error('Integration metadata must contain ordinary files and directories.');
      }
    };
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const folder = resolve(this.path, (await this.#git(['rev-parse', '--git-path', name])).stdout.trim()); digest.update(`${name}\0`);
      if (existsSync(folder)) { if (!lstatSync(folder).isDirectory()) throw new Error('Integration metadata is not a directory.'); visit(folder, name); }
    }
    return digest.digest('hex');
  }
  async abortRebase(assertCurrent?: () => void | Promise<void>): Promise<void> {
    if (this.project.branchPolicy !== 'main') throw new Error('External projects cannot rebase.');
    await this.ownership.assert(this.project, this.owner);
    await assertCurrent?.();
    if (await this.rebaseInProgress()) await this.#git(['rebase', '--abort']);
  }
  async assertIntegrated(): Promise<void> {
    await this.#write();
    if (await this.rebaseInProgress() || !await this.clean() || (await this.#git(['ls-files', '--unmerged'])).stdout) throw new Error('Integration is unfinished.');
    const check = await this.#git(['diff', '--check', 'refs/remotes/origin/main', 'HEAD'], [1, 2]);
    if (/leftover conflict marker/.test(check.stdout + check.stderr)) throw new Error('Integration still contains conflict markers.');
    if (!await this.contains(await this.upstream())) throw new Error('Integration did not include the latest main.');
  }
  async push(expectedHead: string, assertLease: () => Promise<void>): Promise<'pushed' | 'rejected'> {
    await this.#write();
    if (!await this.clean() || await this.head() !== expectedHead) throw new Error('The verified checkpoint changed before publication.');
    await assertLease();
    const result = await this.#git(['push', '--porcelain', 'origin', `${expectedHead}:refs/heads/main`], [1]);
    if (result.code === 0) return 'pushed';
    if (/\[rejected\].*(?:fetch first|non-fast-forward)/.test(result.stdout + result.stderr)) return 'rejected';
    throw new Error(`Publication failed: ${this.redactor.text((result.stderr || result.stdout).trim())}`);
  }
}
