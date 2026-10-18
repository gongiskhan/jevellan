import { expect, test } from 'vitest';
import { AccountSchema, ModelOptionSchema, ModelMenuSchema, reconcileEndpointMenu } from '../packages/core/dist/index.js';
test('an owner-disabled menu entry frees a slot for an endpoint without dropping enabled choices', () => {
  const account = AccountSchema.parse({ schema: 'account-v2', id: 'custom', runtime: 'claude', label: 'Custom', kind: 'endpoint', enabled: true, credential: 'shared', endpoint: { baseUrl: 'http://127.0.0.1:1', billing: 'free', models: [{ id: 'fixture-custom', label: 'Custom model', efforts: ['medium'], description: 'Small work.' }] } });
  const menu = Array.from({ length: 19 }, (_, i) => ModelOptionSchema.parse({ id: `model_${i}`, runtime: 'claude', model: `native-${i}`, label: `Native ${i}`, description: 'Native work.', efforts: ['medium'], enabled: i !== 0 }));
  const next = reconcileEndpointMenu(menu, [account]); expect(ModelMenuSchema.parse(next)).toEqual(next); expect(next).toHaveLength(20); expect(next.filter(row => row.enabled)).toHaveLength(19); expect(next.find(row => row.id === 'model_0')).toMatchObject({ enabled: false }); expect(next.some(row => row.model === 'fixture-custom' && row.enabled)).toBe(true);
  expect(next.filter(row => !row.endpointAccountId).map(row => row.id)).toEqual(menu.map(row => row.id));
});

test('a nineteenth enabled choice is valid and a twentieth is refused even with retained disabled definitions', () => {
  const menu = Array.from({ length: 20 }, (_, i) => ModelOptionSchema.parse({ id: `cap_${i}`, runtime: 'claude', model: `native-${i}`, label: `Native ${i}`, description: 'Native work.', efforts: ['medium'], enabled: i !== 0 }));
  expect(ModelMenuSchema.safeParse(menu).success).toBe(true);
  expect(ModelMenuSchema.safeParse(menu.map(row => ({ ...row, enabled: true }))).success).toBe(false);
});
