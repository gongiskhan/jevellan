import { z } from 'zod';
import { IdSchema } from './schemas.js';

export const ProjectViewNoticeSchema = z.strictObject({ schema: z.literal('project-view-notice-v1'), id: z.number().int().positive(),
  decisionId: IdSchema, text: z.string().min(1).max(500) });
export type ProjectViewNotice = z.infer<typeof ProjectViewNoticeSchema>;
