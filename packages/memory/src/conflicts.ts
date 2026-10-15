import { resolve } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { GitConflictResolutionSchema, inside, type GitConflict, type GitConflictResolution, type GitWorkspace, type Project } from '@jevellan/core';

function isMemoryPath(project: Project, path: string): boolean {
  if (project.memory.mode !== 'repo') return false;
  const root = resolve('/jevellan-project'); const memory = resolve(root, project.memory.dir); const file = resolve(root, path);
  return memory !== root && file !== memory && inside(root, memory) && inside(memory, file);
}
function unresolved(content: string): string {
  const front = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (front) {
    const document = parseDocument(front[1]!);
    if (!document.errors.length && isMap(document.contents)) {
      document.set('status', 'unresolved');
      return `---\n${document.toString()}---\n${content.slice(front[0].length)}`;
    }
  }
  // Invalid metadata is retained as authored text under a valid outer status.
  return `---\nstatus: unresolved\n---\n${content}`;
}

/** Preserve both authored versions; resolving Git does not reconcile their meaning. */
export function memoryConflictResolutions(project: Project, conflicts: GitConflict[], deviceId: string, at: string): GitConflictResolution[] | null {
  if (!conflicts.length || !conflicts.every((file) => isMemoryPath(project, file.path) && /\.(?:md|markdown)$/i.test(file.path)
    && [file.base, file.upstream, file.local].every((side) => !side || ['100644', '100755'].includes(side.mode) && side.content !== null))) return null;
  return conflicts.map((file) => GitConflictResolutionSchema.parse({ schema: 'git-conflict-resolution-v1', path: file.path,
    content: preserveBothVersions(file.upstream?.content ?? null, file.local?.content ?? null, deviceId, at), mode: file.upstream?.mode ?? file.local?.mode ?? '100644' }));
}
/** One note's two conflicting versions: upstream first, marked unresolved, then the local version under `## Merged from`. */
export function preserveBothVersions(upstream: string | null, local: string | null, deviceId: string, at: string): string {
  const device = deviceId.replace(/[\r\n]/g, ' '); const date = new Date(at).toISOString().slice(0, 10);
  const primary = upstream ?? 'This note was deleted upstream. Its local version is preserved below.\n';
  const other = local ?? 'This device deleted the note; the upstream version is preserved above.\n';
  return `${unresolved(primary)}${primary.endsWith('\n') ? '\n' : '\n\n'}## Merged from ${device} on ${date}\n\n${other}${other.endsWith('\n') ? '' : '\n'}`;
}

/** Verification may be skipped only after checking the complete owned change. */
export async function onlyMemoryChanges(workspace: GitWorkspace, base: string): Promise<boolean> {
  const paths = await workspace.changedPaths(base);
  return paths.length > 0 && paths.every((path) => isMemoryPath(workspace.project, path));
}
