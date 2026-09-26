import { defineConfig } from '@playwright/test';

// A separate port base lets two browser runs share one machine (for example JEVELLAN_E2E_PORT_BASE=19871).
const base = Number(process.env.JEVELLAN_E2E_PORT_BASE ?? 19771);

const projects = ['light', 'dark'].flatMap((colorScheme, theme) => [
  { name: `desktop-${colorScheme}`, testIgnore: 'installation.spec.ts', use: { baseURL: `http://127.0.0.1:${base + theme * 2}`, viewport: { width: 1440, height: 900 }, colorScheme: colorScheme as 'light' | 'dark' } },
  { name: `phone-${colorScheme}`, testIgnore: 'installation.spec.ts', use: { baseURL: `http://127.0.0.1:${base + 1 + theme * 2}`, viewport: { width: 390, height: 844 }, colorScheme: colorScheme as 'light' | 'dark' } },
]);
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, timeout: 120_000, workers: 4,
  use: { trace: 'retain-on-failure', actionTimeout: 15_000, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  projects: [...projects, { name: 'installation', workers: 1, testMatch: 'installation.spec.ts' }],
  webServer: projects.map((project, index) => ({ command: `node scripts/test-server.mjs --port ${base + index}`, url: `${project.use.baseURL}/api/health`, reuseExistingServer: false })),
});
