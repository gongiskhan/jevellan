import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { OwnerCommandSchema, OwnerCommandRunReceiptSchema, type OwnerCommand } from './owner-command-schemas.js';
export type OwnerCommandScopeFacts = { projectId?: string | undefined; threadId?: string | undefined; decisionId?: string | undefined; deviceId?: string | undefined; cwd?: 'worktree' | 'checkout' | undefined };
export function mergeOwnerCommandScope(parent: OwnerCommandScopeFacts | undefined, value: OwnerCommandScopeFacts, threadDevice?: string | ((id: string) => string | undefined)) {
  const scope = { ...parent, ...value };
  if (value.threadId && !('deviceId' in value)) scope.deviceId = typeof threadDevice === 'function' ? threadDevice(value.threadId) : threadDevice;
  else if (value.deviceId === undefined) scope.deviceId = parent?.deviceId;
  return scope;
}
export const isOwnerShellFence = (language?: string): boolean => /^language-(?:bash|sh|zsh|shell|console)$/u.test(language ?? '');
export function shellOwnerCommand(command: string, cwd: 'worktree' | 'checkout'): OwnerCommand { return { command: command.replace(/\n$/u, ''), why: 'Run the command from this session.', cwd }; }
export const OwnerCommandPresentationSchema = z.strictObject({ schema: z.literal('owner-command-presentation-v1'), deviceId: IdSchema.nullable(), deviceName: z.string().nullable(), header: z.string(), copyOnly: z.boolean(), copyLabel: z.string(), runLabel: z.string(), openLabel: z.string(), overflowText: z.string(), receiptPrefix: z.string(), receiptConnector: z.string(), receipt: OwnerCommandRunReceiptSchema.nullable(), receiptPath: z.string().nullable() });
export type OwnerCommandPresentation = z.infer<typeof OwnerCommandPresentationSchema>;
export function ownerCommandPresentation(command: OwnerCommand, context: { deviceId?: string | undefined; deviceName?: string | undefined; receipt?: z.infer<typeof OwnerCommandRunReceiptSchema> | null | undefined }): OwnerCommandPresentation {
  const copyOnly = command.kind === 'prompt', deviceId = command.deviceId ?? context.deviceId ?? null, deviceName = context.deviceName ?? deviceId;
  const receipt = copyOnly ? null : context.receipt ?? null;
  return OwnerCommandPresentationSchema.parse({ schema: 'owner-command-presentation-v1', deviceId, deviceName, copyOnly,
    header: copyOnly ? `Paste into the Claude app on ${deviceName ?? 'the session device'}` : `${deviceName ?? 'Session device'} · ${command.cwd}`,
    copyLabel: 'Copy', runLabel: 'Run in Terminal', openLabel: 'Open terminal', overflowText: 'Scroll sideways to read the full command.', receiptPrefix: 'Ran in terminal at', receiptConnector: 'on', receipt, receiptPath: receipt ? `/terminals/${receipt.terminalId}` : null });
}
export const OwnerCommandViewRequestSchema = z.strictObject({ schema: z.literal('owner-command-view-request-v1'), projectId: IdSchema, threadId: IdSchema.optional(), decisionId: IdSchema.optional(), scopeDeviceId: IdSchema.optional(), command: OwnerCommandSchema });
export const OwnerCommandViewSchema = z.strictObject({ schema: z.literal('owner-command-view-v1'), projectId: IdSchema, presentation: OwnerCommandPresentationSchema });
export function ownerCommandReadRequest(scope: OwnerCommandScopeFacts, command: OwnerCommand) { return { schema: 'owner-command-view-request-v1' as const, projectId: scope.projectId!, ...(scope.threadId ? { threadId: scope.threadId } : {}), ...(scope.decisionId ? { decisionId: scope.decisionId } : {}), ...(scope.deviceId ? { scopeDeviceId: scope.deviceId } : {}), command }; }
export function ownerCommandRunRequest(scope: OwnerCommandScopeFacts, command: OwnerCommand, clientRequestId: string) { return { schema: 'owner-command-run-request-v1' as const, clientRequestId, projectId: scope.projectId!, ...(scope.threadId ? { threadId: scope.threadId } : {}), ...(scope.decisionId ? { decisionId: scope.decisionId } : {}), command }; }
