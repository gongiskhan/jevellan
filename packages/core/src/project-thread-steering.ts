import { z } from 'zod';

export const THREAD_INTERRUPT_LABEL = 'Interrupt current turn';
export const ThreadSteeringViewSchema = z.strictObject({ schema: z.literal('project-thread-steering-view-v1'), offered: z.boolean(), label: z.string() });
export type ThreadSteeringView = z.infer<typeof ThreadSteeringViewSchema>;
/** Availability is a read fact; the canonical writer still guards current resources and deduplicates client ids. */
export function threadSteeringView(input: { running: boolean; block: string | null }): ThreadSteeringView {
  return ThreadSteeringViewSchema.parse({ schema: 'project-thread-steering-view-v1', offered: input.running && !input.block, label: THREAD_INTERRUPT_LABEL });
}
/** A checkbox choice from a finished turn never becomes an interrupt on an idle send. */
export const threadMessageInterrupt = (running: boolean, requested: boolean): boolean => running && requested;
