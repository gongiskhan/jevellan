import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from './homes.js';

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
    if (!info.isFile() || info.size > 32_768) throw new Error(`Project ${filename} must be a file of at most 32768 bytes.`);
    const bytes = readFileSync(target);
    if (bytes.length > 32_768) throw new Error(`Project ${filename} must be a file of at most 32768 bytes.`);
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
