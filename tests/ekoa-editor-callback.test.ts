import { expect, test } from 'vitest';
import * as core from '../packages/core/dist/index.js';

test('mirror callback input keeps ephemeral code only in the normal callback request', () => {
  const prepare = (core as unknown as { ekoaCallbackInput(search: string): { schema: string; state: string; code?: string; error?: string } }).ekoaCallbackInput;
  const state = 'fixture_callback_state_long_enough', code = 'fixture_disposable_code';
  const value = prepare(new URLSearchParams({ state, code, error: '' }).toString());
  expect(value.schema).toBe('ekoa-oauth-callback-v1'); expect(value.state === state).toBe(true); expect(value.code === code).toBe(true); expect('error' in value).toBe(false);
  expect(prepare(new URLSearchParams({ state, code: '', error: 'access_denied' }).toString())).toEqual({ schema: 'ekoa-oauth-callback-v1', state, error: 'access_denied' });
  expect(() => prepare('state=short')).toThrow();
});
