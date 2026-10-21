import { z } from 'zod';
export const ProjectSetupPresentationSchema = z.strictObject({ schema: z.literal('project-setup-presentation-v1'),
  items: z.array(z.strictObject({ index: z.number().int().min(0).max(11), label: z.string() })).max(12), appliedLine: z.string().nullable(),
});
