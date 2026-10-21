import { FakeRuntime } from '../../packages/runtime-contract/dist/index.js';
import { projectFixture } from './project-fixture.js';
export async function accountEditorFixture(options: { control?: boolean } = {}) {
  const claude = new FakeRuntime();
  Object.defineProperty(claude, 'id', { value: 'claude' });
  Object.defineProperty(claude, 'accountKinds', { value: ['subscription', 'api-key', 'endpoint'] });
  const fake = new FakeRuntime(); Object.defineProperty(fake, 'accountKinds', { value: ['subscription'] });
  return projectFixture({ ...options, runtimes: { fake, claude } });
}
