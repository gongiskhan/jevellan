import { z } from 'zod';
import { IdSchema } from './schemas.js';

export const ThreadImageReferencesSchema = z.array(z.string().max(4096));
export const ThreadImagesViewSchema = z.strictObject({ schema: z.literal('project-thread-images-v1'), projectId: IdSchema, threadId: IdSchema,
  refs: ThreadImageReferencesSchema.max(200) });
export type ThreadImagesView = z.infer<typeof ThreadImagesViewSchema>;
