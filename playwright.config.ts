import { defineConfig } from '@playwright/test';

// A separate port base lets two browser runs share one machine (for example JEVELLAN_E2E_PORT_BASE=19871).
const base = Number(process.env.JEVELLAN_E2E_PORT_BASE ?? 19771);

const layouts = ['light', 'dark'].flatMap((colorScheme) => [
  { name: `desktop-${colorScheme}`, use: { viewport: { width: 1440, height: 900 }, colorScheme: colorScheme as 'light' | 'dark' } },
  { name: `phone-${colorScheme}`, use: { viewport: { width: 390, height: 844 }, colorScheme: colorScheme as 'light' | 'dark' } },
]);
// The improver journeys save a Jev key and run hub-wide jobs, so they get their own fixture servers
// instead of sharing hub state with journeys that start from missing configuration.
const projects = [
  ...layouts.map((layout, index) => ({ name: layout.name, metadata: { layout: layout.name }, testIgnore: ['installation.spec.ts', 'improver.spec.ts'], use: { ...layout.use, baseURL: `http://127.0.0.1:${base + index}` } })),
  ...layouts.map((layout, index) => ({ name: `${layout.name}-improver`, metadata: { layout: layout.name }, testMatch: 'improver.spec.ts', use: { ...layout.use, baseURL: `http://127.0.0.1:${base + layouts.length + index}` } })),
];
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, timeout: 120_000, workers: 4,
  use: { trace: 'retain-on-failure', actionTimeout: 15_000, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  projects: [...projects, { name: 'installation', workers: 1, testMatch: 'installation.spec.ts' }],
  webServer: projects.map((project, index) => ({ command: `node scripts/test-server.mjs --port ${base + index}`, url: `${project.use.baseURL}/api/health`, reuseExistingServer: false })),
});
