import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:19771', trace: 'retain-on-failure' },
  projects: ['light', 'dark'].flatMap((colorScheme) => [
    { name: `desktop-${colorScheme}`, use: { viewport: { width: 1440, height: 900 }, colorScheme: colorScheme as 'light' | 'dark' } },
    { name: `phone-${colorScheme}`, use: { viewport: { width: 390, height: 844 }, colorScheme: colorScheme as 'light' | 'dark' } },
  ]),
  webServer: {
    command: 'node scripts/test-server.mjs',
    url: 'http://127.0.0.1:19771/api/health',
    reuseExistingServer: false,
  },
});
