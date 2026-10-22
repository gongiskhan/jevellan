import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { CursorConnectionSchema, CursorConnectionsSchema } from './cursor-schemas.js';

export const NativeConnectionFieldsSchema = z.strictObject({ name: z.string(), user: z.string(), port: z.string(), host: z.string(),
  identityFile: z.string(), helperPath: z.string(), nodePath: z.string(), home: z.string(), gatewayHost: z.string(), gatewayUser: z.string() });
export type NativeConnectionFields = z.infer<typeof NativeConnectionFieldsSchema>;
export const NativeConnectionContextSchema = z.strictObject({ schema: z.literal('native-connection-context-v1'), deviceId: IdSchema,
  draftId: IdSchema.refine(id => id.startsWith('cursor_remote_'), 'A connection draft needs a remote connection id.') });
export const NativeConnectionCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('native-connection-command-v1'), operation: z.literal('add'), context: NativeConnectionContextSchema, fields: NativeConnectionFieldsSchema }),
  z.strictObject({ schema: z.literal('native-connection-command-v1'), operation: z.literal('remove'), context: NativeConnectionContextSchema, id: IdSchema }),
]);
export const NativeConnectionSummarySchema = z.strictObject({ schema: z.literal('native-connection-summary-v1'), id: IdSchema, text: z.string() });
export function nativeConnectionSummary(raw: unknown) {
  const row = CursorConnectionSchema.parse(raw);
  return NativeConnectionSummarySchema.parse({ schema: 'native-connection-summary-v1', id: row.id,
    text: row.host ? `Existing SSH · ${row.host}` : `Existing tunnel · ${row.gateway ? row.gateway.host + ' · ' : ''}port ${row.port}` });
}
export const NativeConnectionFieldsViewSchema = z.strictObject({ schema: z.literal('native-connection-fields-view-v1'), gatewayVisible: z.boolean(), identityPlaceholder: z.string() });
export function nativeConnectionFieldsView(raw: unknown) {
  const fields = NativeConnectionFieldsSchema.parse(raw), gatewayVisible = !!fields.gatewayHost.trim();
  return NativeConnectionFieldsViewSchema.parse({ schema: 'native-connection-fields-view-v1', gatewayVisible,
    identityPlaceholder: gatewayVisible ? 'Absolute path on the gateway' : 'Absolute path on this device' });
}
export const NativeConnectionsEditorSchema = z.strictObject({ schema: z.literal('native-connections-editor-v1'), deviceId: IdSchema,
  context: NativeConnectionContextSchema, fields: NativeConnectionFieldsSchema, port: z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() }),
  rows: z.array(z.strictObject({ connection: CursorConnectionSchema, summary: NativeConnectionSummarySchema, remove: NativeConnectionCommandSchema })) })
  .refine(view => view.deviceId === view.context.deviceId, 'The connection editor must belong to its device.');
export type NativeConnectionsEditor = z.infer<typeof NativeConnectionsEditorSchema>;
export function nativeConnectionsEditor(raw: unknown, rawContext: unknown): NativeConnectionsEditor {
  const state = CursorConnectionsSchema.parse(raw), context = NativeConnectionContextSchema.parse(rawContext);
  return NativeConnectionsEditorSchema.parse({ schema: 'native-connections-editor-v1', deviceId: context.deviceId, context, port: { min: 1, max: 65535 },
    fields: { name: 'CSG', user: '', port: '', host: '', identityFile: '', helperPath: '', nodePath: '/usr/bin/node', home: '', gatewayHost: '', gatewayUser: '' },
    rows: state.connections.map(connection => ({ connection, summary: nativeConnectionSummary(connection), remove: {
      schema: 'native-connection-command-v1', operation: 'remove', context, id: connection.id } })) });
}
export function nativeConnectionAddCommand(context: unknown, fields: unknown) {
  return NativeConnectionCommandSchema.parse({ schema: 'native-connection-command-v1', operation: 'add', context, fields });
}
export const NativeConnectionPreparationSchema = z.strictObject({ schema: z.literal('native-connections-preparation-v1'), connections: CursorConnectionsSchema, repeated: z.boolean() });
const refuse = (message: string) => Object.assign(new Error(message), { status: 409 });
/** Read and merge the current list at execution; a captured removal never replaces somebody else's newer rows. */
export function prepareNativeConnectionCommand(raw: unknown, rawCommand: unknown, deviceId: string) {
  const state = CursorConnectionsSchema.parse(raw), command = NativeConnectionCommandSchema.parse(rawCommand);
  if (command.context.deviceId !== deviceId) throw refuse('Configure the connection from its owning device.');
  let connections = state.connections, repeated = false;
  if (command.operation === 'add') {
    const fields = command.fields;
    const connection = CursorConnectionSchema.parse({ id: command.context.draftId, name: fields.name, user: fields.user, port: Number(fields.port),
      ...(fields.host.trim() ? { host: fields.host.trim() } : {}), nodePath: fields.nodePath, home: fields.home, helperPath: fields.helperPath,
      ...(fields.identityFile.trim() ? { identityFile: fields.identityFile.trim() } : {}),
      ...(fields.gatewayHost.trim() ? { gateway: { host: fields.gatewayHost.trim(), user: fields.gatewayUser.trim() } } : {}) });
    const old = connections.find(row => row.id === connection.id);
    if (old && JSON.stringify(old) !== JSON.stringify(connection)) throw refuse('This connection was already saved with different settings. Reload before adding another.');
    repeated = !!old;
    if (!old) connections = [...connections, connection];
  } else {
    connections = connections.filter(row => row.id !== command.id); repeated = connections.length === state.connections.length;
  }
  return NativeConnectionPreparationSchema.parse({ schema: 'native-connections-preparation-v1', connections: { schema: 'cursor-connections-v1', connections }, repeated });
}
export const NativeConnectionsSavedSchema = z.strictObject({ schema: z.literal('native-connections-saved-v1'), repeated: z.boolean(), editor: NativeConnectionsEditorSchema });
export const NativeConnectionsOperationSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('native-connections-operation-v1'), deviceId: IdSchema, operation: z.literal('read') }),
  z.strictObject({ schema: z.literal('native-connections-operation-v1'), deviceId: IdSchema, operation: z.literal('command'), request: NativeConnectionCommandSchema }),
]);
