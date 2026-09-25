import { z } from 'zod';
import { ProjectVisibilitySchema } from './conversation-schemas.js';
import { gitEnvironment, runOwnedCommand } from './command.js';
import { resolveProjectPath } from './homes.js';
import type { Project } from './schemas.js';

export type RepositoryVisibility = z.infer<typeof ProjectVisibilitySchema>['visibility'];
export type VisibilityProbe = (path: string) => Promise<RepositoryVisibility>;
const GitHubVisibility = z.object({ visibility: z.enum(['PUBLIC', 'PRIVATE', 'INTERNAL']) });
export async function probeRepositoryVisibility(path: string, run = runOwnedCommand): Promise<RepositoryVisibility> {
  try {
    const result = await run('gh', ['repo', 'view', '--json', 'visibility'], { cwd: path, env: { ...gitEnvironment(), GH_PROMPT_DISABLED: '1' }, timeoutMs: 5000 });
    if (result.code !== 0 || result.timedOut) return 'UNKNOWN';
    return GitHubVisibility.parse(JSON.parse(result.stdout)).visibility;
  } catch { return 'UNKNOWN'; }
}
export class ProjectVisibility {
  readonly #pending = new Map<string, Promise<RepositoryVisibility>>();
  constructor(readonly probe: VisibilityProbe = probeRepositoryVisibility) {}
  async inspect(project: Project, deviceId: string) {
    const path = resolveProjectPath(project, deviceId); let pending = this.#pending.get(path);
    if (!pending) {
      pending = Promise.resolve().then(() => this.probe(path)).catch(() => 'UNKNOWN' as const); this.#pending.set(path, pending);
      void pending.finally(() => { if (this.#pending.get(path) === pending) this.#pending.delete(path); });
    }
    return ProjectVisibilitySchema.parse({ schema: 'project-visibility-v1', projectId: project.id, deviceId, visibility: await pending, checkedAt: new Date().toISOString() });
  }
}
