import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from './homes.js';
import type { ProjectInstructionBudget } from './schemas.js';

/** Managed launches raise the native document budget without allowing unbounded project input. */
export const PROJECT_INSTRUCTION_MAX_BYTES = 256 * 1024;

/** No contents or private filesystem errors enter presence/placement documents. */
export function projectInstructionBudget(cwd: string): ProjectInstructionBudget {
  const budget: ProjectInstructionBudget = { schema: 'project-instruction-budget-v1', maxBytes: PROJECT_INSTRUCTION_MAX_BYTES, filename: null, bytes: null, state: 'none' };
  try {
    const root = realpathSync(cwd);
    for (const filename of ['AGENTS.md', 'CLAUDE.md'] as const) {
      try { lstatSync(join(root, filename)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      budget.filename = filename;
      const target = realpathSync(join(root, filename));
      if (!inside(root, target)) return { ...budget, state: 'outside-project' };
      const info = statSync(target); budget.bytes = info.size;
      return { ...budget, state: !info.isFile() ? 'not-file' : info.size > budget.maxBytes ? 'too-large' : 'ready' };
    }
    return budget;
  } catch { return { ...budget, state: 'unreadable' }; }
}

export function codexInstructionRefusal(budget: ProjectInstructionBudget | undefined): string | undefined {
  if (!budget) return 'Codex project instruction budget has not been reported by this device yet.';
  const file = budget.filename ?? 'instruction file';
  if (budget.bytes !== null && budget.bytes > budget.maxBytes) return `Project ${file} is ${budget.bytes} bytes; Codex accepts at most ${budget.maxBytes} bytes on this device.`;
  if (budget.state === 'ready' || budget.state === 'none') return undefined;
  return `Codex cannot use the project ${file}: ${budget.state === 'outside-project' ? 'it resolves outside the project' : budget.state === 'not-file' ? 'it is not a regular file' : budget.state === 'too-large' ? 'it exceeds this device instruction budget' : 'it cannot be read on this device'}.`;
}

/** Select by presence; an invalid AGENTS.md never silently enables CLAUDE.md. */
export function projectInstructionFile(cwd: string): { filename: 'AGENTS.md' | 'CLAUDE.md'; text: string } | null {
  const root = realpathSync(cwd);
  for (const filename of ['AGENTS.md', 'CLAUDE.md'] as const) {
    const path = join(root, filename);
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const target = realpathSync(path);
    if (!inside(root, target)) throw new Error(`Project ${filename} must resolve inside the project.`);
    const info = statSync(target);
    if (!info.isFile() || info.size > PROJECT_INSTRUCTION_MAX_BYTES) throw new Error(`Project ${filename} must be a file of at most ${PROJECT_INSTRUCTION_MAX_BYTES} bytes.`);
    const bytes = readFileSync(target);
    if (bytes.length > PROJECT_INSTRUCTION_MAX_BYTES) throw new Error(`Project ${filename} must be a file of at most ${PROJECT_INSTRUCTION_MAX_BYTES} bytes.`);
    return { filename, text: bytes.toString('utf8') };
  }
  return null;
}
export function projectInstructions(cwd: string): string { return projectInstructionFile(cwd)?.text ?? ''; }
/** Read afresh on every launch, including session resumes. */
export function projectInstructionPrompt(cwd: string): string {
  const file = projectInstructionFile(cwd);
  return file ? `# Project instructions: ${file.filename}\n${file.text}\n\n` : '';
}
