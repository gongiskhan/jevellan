import { z } from 'zod';
export const EkoaUrlSchema = z.url().max(2000).refine(raw => {
  let url: URL; try { url = new URL(raw); } catch { return false; } return !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}, 'Use an HTTPS MCP URL without credentials, query or fragment.');
