import { ThreadImagesViewSchema, sessionImages, type ThreadImagesView, type ThreadView } from '@jevellan/core';

/** Reference discovery only; image bytes remain behind the existing owner-bound file route. */
export function threadImagesView(view: Pick<ThreadView, 'thread' | 'transcript' | 'reports'>): ThreadImagesView {
  return ThreadImagesViewSchema.parse({ schema: 'project-thread-images-v1', projectId: view.thread.projectId, threadId: view.thread.id,
    refs: sessionImages(view.transcript?.turns ?? [], view.reports) });
}
