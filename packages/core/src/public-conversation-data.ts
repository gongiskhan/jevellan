/** Process identities are recovery data, never browser timeline content. */
export function publicConversationData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  if (data.schema === 'work-control-v1' && data.kind === 'native') return { schema: 'conversation-process-v1', stretch: data.n };
  if (data.schema === 'stretch-v2') { const copy = { ...data }; delete copy.native; return copy; }
  if (data.schema === 'stretch-finished-v1') return { ...data, stretch: publicConversationData(data.stretch) };
  if ('id' in data && 't' in data && 'type' in data && 'data' in data) return { ...data, data: publicConversationData(data.data) };
  return value;
}

