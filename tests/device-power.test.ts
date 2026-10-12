import { expect, test } from 'vitest';

test('hub power readiness reads AC sleep rather than battery or display sleep', async () => {
  const { readDevicePower } = await import('../packages/core/dist/device-facts.js');
  const output = 'Battery Power:\n sleep 1\nAC Power:\n displaysleep 10\n sleep 0\n';
  expect(readDevicePower('darwin', () => output)).toMatchObject({ schema: 'device-power-v1', status: 'available', acSleepMinutes: 0 });
  expect(readDevicePower('darwin', () => output.replace(' sleep 0', ' sleep 15'))).toMatchObject({ status: 'available', acSleepMinutes: 15 });
});
test('unreadable power settings stay unknown and Linux never invokes the Mac reader', async () => {
  const { readDevicePower } = await import('../packages/core/dist/device-facts.js');
  expect(readDevicePower('darwin', () => { throw new Error('private fixture output'); })).toMatchObject({ status: 'unavailable' });
  expect(readDevicePower('darwin', () => 'Battery Power:\n sleep 1')).toMatchObject({ status: 'unavailable' });
  expect(readDevicePower('linux', () => { throw new Error('Must not run'); })).toMatchObject({ status: 'not-applicable' });
});
