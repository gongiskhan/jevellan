import { z } from 'zod';

const textField = z.strictObject({ maxLength: z.number().int().positive(), help: z.string().min(1).max(1000) });
/** Presentation of canonical settings policy; absent only on older settings responses. */
export const ProjectConfigurationInfoSchema = z.strictObject({ schema: z.literal('project-configuration-info-v1'),
  instructions: textField, guidance: textField,
  pauseHelp: z.string().min(1).max(1000), archiveHelp: z.string().min(1).max(1000),
  dailyThreadHelp: z.string().min(1).max(1000), conflictText: z.string().min(1).max(1000),
});
export type ProjectConfigurationInfo = z.infer<typeof ProjectConfigurationInfoSchema>;
