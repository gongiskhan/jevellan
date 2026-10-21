export const ACCOUNT_PAID_LABELS = { always: 'Always', 'when-subscriptions-run-out': 'Only when this runtime’s subscriptions run out', never: 'Never automatically' } as const;
export const ACCOUNT_KIND_LABELS = { subscription: 'Subscription', 'api-key': 'API key', endpoint: 'Compatible endpoint' } as const;
export const ACCOUNT_EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' } as const;
export const ACCOUNT_ENDPOINT_COPY = {
  type: 'Compatible endpoint', baseUrl: 'Base URL', placeholder: 'https://api.example.com/anthropic', token: 'Auth token', billing: 'Billing',
  subscription: 'Plan or subscription', metered: 'Pay per use', free: 'Free (local)', paid: 'When Jevellan may use it',
  help: "Any server that speaks the Anthropic Messages API: Z.ai's GLM endpoint, DeepSeek, or a local server or proxy in front of a local model.",
  models: 'Models', modelId: 'Model id', label: 'Label', efforts: 'Efforts', description: 'When to use it (Jev reads this)', addModel: 'Add model', removeModel: 'Remove model',
  background: 'Background model', backgroundHelp: "Used for Claude Code's small background calls. Defaults to the first model.", keyRefused: 'Key refused',
} as const;
export const accountIsMetered = (kind: string, billing?: string) => kind === 'api-key' || kind === 'endpoint' && billing === 'metered';
/** Credential presence is sufficient for readonly preparation; canonical saves validate the actual value separately. */
export function accountInputIssues(value: { kind: string; runtime: string; paidUse?: string | undefined; endpoint?: { billing: string } | undefined }, credentialPresent: boolean): string[] {
  const issues: string[] = [];
  if (value.kind === 'api-key' && (!value.paidUse || !credentialPresent)) issues.push('Enter the key and choose when Jevellan may use it.');
  if ((value.kind === 'subscription' || value.kind === 'endpoint' && value.endpoint?.billing !== 'metered') && value.paidUse) issues.push('Paid-use policy applies only to API keys.');
  if (value.kind === 'endpoint' && (!value.endpoint || !credentialPresent || value.runtime !== 'claude' || value.endpoint.billing === 'metered' && !value.paidUse)) issues.push('Enter the endpoint, auth token and billing policy.');
  if (value.kind !== 'endpoint' && value.endpoint) issues.push('Endpoint settings belong to compatible-endpoint accounts.');
  if (value.runtime === 'codex' && value.kind === 'subscription' && credentialPresent) issues.push('Codex subscription sign-in belongs to this device.');
  return issues;
}
