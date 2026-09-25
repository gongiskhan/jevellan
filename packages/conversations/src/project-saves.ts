import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ContextRequestSchema, IdSchema, ProjectSchema, ProjectWriteSchema, readDocument, stableJson, writeDocument, type Homes } from '@jevellan/core';

const ProjectSaveSchema = z.strictObject({
  schema: z.literal('project-save-v1'), id: IdSchema, request: ProjectWriteSchema,
  project: ProjectSchema, context: ContextRequestSchema.optional(),
});
type ProjectSave = z.infer<typeof ProjectSaveSchema>;

/** Freeze local context inspection before the shared project mutation can commit. */
export class ProjectSaves {
  constructor(readonly homes: Homes) {}
  get(id: string, request: ProjectSave['request']): ProjectSave | undefined {
    const path = this.homes.at('project-saves', `${IdSchema.parse(id)}.json`);
    if (!existsSync(path)) return undefined;
    const saved = readDocument(path, ProjectSaveSchema);
    if (saved.id !== id || stableJson(saved.request) !== stableJson(request)) throw Object.assign(new Error('This project save request was already used for different settings. Reopen the project before saving.'), { status: 409 });
    return saved;
  }
  prepare(raw: ProjectSave): ProjectSave {
    const value = ProjectSaveSchema.parse(raw);
    return this.get(value.id, value.request) ?? writeDocument(this.homes.at('project-saves', `${value.id}.json`), ProjectSaveSchema, value);
  }
}
