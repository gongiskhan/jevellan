import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'apps/web/lib/**', '**/node_modules/**', 'test-results/**', 'test-results-*/**', 'playwright-report/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', fetch: 'readonly' } } },
  { files: ['apps/web/public/sw.js'], languageOptions: { globals: { self: 'readonly', caches: 'readonly', Response: 'readonly' } } },
  { files: ['site/assets/js/*.js'], languageOptions: { globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', IntersectionObserver: 'readonly', MutationObserver: 'readonly' } } },
);
