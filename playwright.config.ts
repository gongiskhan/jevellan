import { defineConfig } from '@playwright/test';

const projects = ['light', 'dark'].flatMap((colorScheme, theme) => [
  { name: `desktop-${colorScheme}`, testIgnore: 'installation.spec.ts', use: { baseURL: `http://127.0.0.1:${19771 + theme * 2}`, viewport: { width: 1440, height: 900 }, colorScheme: colorScheme as 'light' | 'dark' } },
  { name: `phone-${colorScheme}`, testIgnore: 'installation.spec.ts', use: { baseURL: `http://127.0.0.1:${19772 + theme * 2}`, viewport: { width: 390, height: 844 }, colorScheme: colorScheme as 'light' | 'dark' } },
]);
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, timeout: 120_000, workers: 4,
  use: { trace: 'retain-on-failure', actionTimeout: 15_000, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  projects: [...projects, { name: 'installation', workers: 1, testMatch: 'installation.spec.ts' }],
  webServer: projects.map((project, index) => ({ command: `node scripts/test-server.mjs --port ${19771 + index}`, url: `${project.use.baseURL}/api/health`, reuseExistingServer: false })),
});
