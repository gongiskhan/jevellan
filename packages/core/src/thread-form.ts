import type { Effort } from './schemas.js';
import type { Isolation } from './project-schemas.js';
export type ThreadForm = { title: string; task: string; isolation: '' | Isolation; modelId: string; effort: '' | Effort; deviceId: string };
/** `POST /api/projects/:id/threads`: fields left on Automatic are omitted, so placement decides them. */
export function threadCreateRequest(clientRequestId: string, form: ThreadForm) {
  return { schema: 'thread-create-request-v1' as const, clientRequestId, title: form.title.trim(), task: form.task.trim(),
    ...(form.isolation ? { isolation: form.isolation } : {}), ...(form.modelId ? { modelId: form.modelId } : {}),
    ...(form.effort ? { effort: form.effort } : {}), ...(form.deviceId ? { deviceId: form.deviceId } : {}) };
}
