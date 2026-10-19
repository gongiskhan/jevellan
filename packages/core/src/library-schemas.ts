import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
export const LIBRARY_FILE_LIMIT = 50 * 1024 * 1024;
export const LIBRARY_QUOTA = 2 * 1024 * 1024 * 1024;
export const ProjectLibraryItemSchema = z.strictObject({ schema: z.literal('project-library-item-v1'), revision: z.number().int().nonnegative(),
  id: IdSchema, projectId: IdSchema, path: z.string().regex(/^(uploads\/\d{4}-\d{2}-\d{2}|(?:outputs|jobs)\/[A-Za-z0-9_-]+)\/[^/]{1,200}$/u),
  name: z.string().min(1).max(200), size: z.number().int().min(0).max(LIBRARY_FILE_LIMIT), mime: z.string().min(1).max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), source: z.enum(['owner', 'thread', 'job']), threadId: IdSchema.optional(), jobRunId: IdSchema.optional(), artifactId: IdSchema.optional(), note: z.string().max(500).optional(),
  createdAt: TimestampSchema, deletedAt: TimestampSchema.optional() });
export type ProjectLibraryItem = z.infer<typeof ProjectLibraryItemSchema>;
export const LibraryListSchema = z.strictObject({ schema: z.literal('project-library-list-v1'), items: z.array(ProjectLibraryItemSchema).max(100), next: IdSchema.nullable(), bytes: z.number().int().nonnegative() });
export const LibraryListInputSchema = z.strictObject({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() });
export const LibraryGetInputSchema = z.strictObject({ itemId: IdSchema });
export const LibraryAddInputSchema = z.strictObject({ path: z.string().min(1).max(1024).refine(path => !path.startsWith('/') && !path.split('/').includes('..'), 'Use a path inside the project, without ..'), name: z.string().min(1).max(200).optional(), note: z.string().max(500).optional() });
export interface ProjectLibrary {
  directory(projectId: string): string;
  list(projectId: string): Promise<ProjectLibraryItem[]>;
  get(projectId: string, itemId: string): Promise<{ localPath: string }>;
  prepare(projectId: string, prompt: string): Promise<void>;
  addJob?(projectId: string, runId: string, artifactId: string, cwd: string, input: z.infer<typeof LibraryAddInputSchema>): Promise<ProjectLibraryItem>;
  add(projectId: string, threadId: string, cwd: string, input: z.infer<typeof LibraryAddInputSchema>): Promise<ProjectLibraryItem>;
}
