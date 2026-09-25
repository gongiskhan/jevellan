import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { ContextChoiceSchema, ContextViewSchema, ProjectSchema, atomicWrite, resolveProjectPath, stableJson, type ContextChoice, type ContextView, type Project } from '@jevellan/core';

type Name = 'AGENTS.md' | 'CLAUDE.md';
const names: Name[] = ['AGENTS.md', 'CLAUDE.md'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** File inspection is read-only; changes require the same ownership as a stretch. */
export class ProjectContext {
  readonly project: Project;
  constructor(project: Project, readonly deviceId: string, readonly assertOwnership: () => void | Promise<void>, readonly claudeReadsAgents = false) {
    this.project = ProjectSchema.parse(project);
  }
  get path(): string { return resolveProjectPath(this.project, this.deviceId); }
  #git(...args: string[]): string {
    return execFileSync('git', ['--no-optional-locks', '-C', this.path, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
  }
  inspect(): ContextView {
    const root = this.path;
    const files = names.map((name) => {
      const file = join(root, name); const tracked = !!this.#git('ls-files', '--', name).trim();
      let stat;
      try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!stat) return { name, kind: 'missing' as const, tracked, hash: hash('missing'), content: '' };
      if (stat.isSymbolicLink()) {
        const target = name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md'; const link = readlinkSync(file);
        if (resolve(root, link) !== join(root, target)) throw new Error(`${name} must link to the other instruction file in this project.`);
        let other;
        try { other = lstatSync(join(root, target)); } catch { /* Report a broken link without following it. */ }
        if (!other?.isFile()) throw new Error(`${name} has a broken or circular context link.`);
        return { name, kind: 'link' as const, tracked, hash: hash(`link:${link}`), content: '', target };
      }
      if (!stat.isFile()) throw new Error(`${name} must be a regular instruction file.`);
      const content = readFileSync(file, 'utf8');
      return { name, kind: 'file' as const, tracked, hash: hash(content), content };
    }) as ContextView['files'];
    const [agents, claude] = files;
    let state: ContextView['state'] = 'none'; let primary: Name | undefined;
    if (agents.kind === 'link' || claude.kind === 'link') { state = 'linked'; primary = agents.kind === 'link' ? 'CLAUDE.md' : 'AGENTS.md'; }
    else if (agents.kind === 'file' && claude.kind === 'file') state = this.project.context.state === 'left-as-is' ? 'left-as-is' : 'needs-decision';
    else if (agents.kind === 'file' || claude.kind === 'file') { primary = agents.kind === 'file' ? 'AGENTS.md' : 'CLAUDE.md'; state = primary === 'AGENTS.md' && this.claudeReadsAgents ? 'linked' : 'none'; }
    return ContextViewSchema.parse({ schema: 'project-context-v1', projectId: this.project.id, state, ...(primary ? { primary } : {}), files,
      fingerprint: hash(stableJson(files.map(({ name, kind, hash, tracked }) => ({ name, kind, hash, tracked })))), claudeReadsAgents: this.claudeReadsAgents });
  }
  #exclude(name: Name): void {
    const file = join(this.#git('rev-parse', '--absolute-git-dir').trim(), 'info', 'exclude');
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''; const pattern = `/${name}`;
    if (!previous.split('\n').includes(pattern)) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${previous && !previous.endsWith('\n') ? '\n' : ''}${pattern}\n`, { mode: 0o600 });
    }
  }
  #link(name: Name, target: Name): void {
    this.#exclude(name);
    const temporary = join(this.path, `.jevellan-context-${randomUUID()}`);
    symlinkSync(target, temporary);
    try { renameSync(temporary, join(this.path, name)); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  #same(expected: string): ContextView {
    const current = this.inspect();
    if (current.fingerprint !== expected) throw Object.assign(new Error('Context files changed. Reload the current files before applying this choice.'), { status: 409 });
    return current;
  }
  async ensure(create = false): Promise<ContextView> {
    const before = this.inspect();
    if (['linked', 'needs-decision', 'left-as-is'].includes(before.state) || (!before.primary && !create)) return before;
    if (this.project.branchPolicy === 'external' && before.files.some((file) => file.kind === 'missing' && file.tracked)) throw new Error('Jevellan cannot replace a tracked context file on an external project.');
    await this.assertOwnership(); this.#same(before.fingerprint);
    if (!before.primary) {
      // A new local instruction file on an external project is never added to git.
      if (this.project.branchPolicy === 'external') this.#exclude('AGENTS.md');
      const text = `# ${this.project.name}\n\n${this.project.testCommand ? `Run tests with \`${this.project.testCommand}\`.\n\n` : ''}Project memory lives in ${this.project.memory.dir}; use the memory tools to read and record durable project knowledge.\n`;
      writeFileSync(join(this.path, 'AGENTS.md'), text, { flag: 'wx', mode: 0o600 });
      this.#link('CLAUDE.md', 'AGENTS.md');
    } else if (before.primary === 'AGENTS.md') this.#link('CLAUDE.md', 'AGENTS.md');
    else this.#link('AGENTS.md', 'CLAUDE.md');
    return this.inspect();
  }
  async choose(raw: ContextChoice): Promise<ContextView> {
    const input = ContextChoiceSchema.parse(raw); const before = this.#same(input.fingerprint);
    if (!before.files.every((file) => file.kind === 'file')) throw new Error('This choice requires two separate instruction files.');
    if (input.choice === 'leave') { this.project.context = { state: 'left-as-is' }; return this.inspect(); }
    const primary: Name = input.choice === 'keep-claude' ? 'CLAUDE.md' : 'AGENTS.md';
    const secondary: Name = primary === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
    if (this.project.branchPolicy === 'external' && (input.choice === 'merge' || before.files.find((file) => file.name === secondary)!.tracked)) throw new Error('This project follows its own git rules. Jevellan can only create local context links here.');
    await this.assertOwnership(); this.#same(input.fingerprint);
    if (input.choice === 'merge') atomicWrite(join(this.path, 'AGENTS.md'), input.content);
    this.#link(secondary, primary);
    this.project.context = { state: 'linked', primary };
    return this.inspect();
  }
}
