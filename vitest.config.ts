import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'runtimes/**/*.test.ts'],
    // Integration cases include bounded native-process shutdown plus Git and HTTP on the owner's busy machine.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    restoreMocks: true,
    maxWorkers: 2,
  },
});
