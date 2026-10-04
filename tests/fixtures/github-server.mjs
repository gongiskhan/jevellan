// Fake GitHub REST server (API version 2022-11-28 shapes) for pull request tests. Plain node:http on an ephemeral port.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const RUNS = { none: [], pending: [{ status: 'queued', conclusion: null }], passing: [{ status: 'completed', conclusion: 'success' }], 'passing-status': [], failing: [{ status: 'completed', conclusion: 'failure' }] };
// GitHub's combined status when no commit status exists: `pending` with zero entries.
const EMPTY_STATUS = { state: 'pending', total_count: 0, statuses: [] };
const MERGEABLE = { clean: true, unstable: true, dirty: false, unknown: null };
const NOT_MERGEABLE = 'Pull Request is not mergeable';

export async function startGitHubFixture({ token, repositories = {}, port = 0 }) {
  if (typeof token !== 'string' || !token) throw new Error('The GitHub fixture needs a token.');
  const requests = []; const pulls = []; const failures = [];
  const origin = (repo) => repositories[repo];
  const headOf = (repo, ref) => {
    try { return execFileSync('git', ['--git-dir', origin(repo), 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
  };
  // Force pushes move the head: re-read it from the bare origin on every call.
  const refresh = (pull) => { const sha = headOf(pull.repo, pull.head); if (sha) pull.headSha = sha; return pull; };
  const find = (number, repo = Object.keys(repositories)[0]) => {
    const pull = pulls.find((entry) => entry.repo === repo && entry.number === Number(number));
    if (!pull) throw new Error(`No fixture pull request ${repo}#${number}.`);
    return pull;
  };
  const view = (pull, list = false) => {
    const [owner] = pull.repo.split('/');
    return { number: pull.number, html_url: `https://github.com/${pull.repo}/pull/${pull.number}`, state: pull.state, title: pull.title, body: pull.body,
      merged_at: pull.merged ? pull.mergedAt : null, head: { sha: pull.headSha, ref: pull.head, label: `${owner}:${pull.head}` }, base: { ref: pull.base },
      // List items carry no merge fields on GitHub.
      ...(list ? {} : { merged: pull.merged, mergeable: MERGEABLE[pull.mergeable] ?? null, mergeable_state: pull.mergeable }) };
  };
  const checksOf = (repo, sha) => {
    // An open pull request wins over closed ones that share the head commit.
    const matching = pulls.filter((entry) => entry.repo === repo).map(refresh).filter((entry) => entry.headSha === sha);
    const pull = matching.find((entry) => entry.state === 'open') ?? matching.at(-1);
    const checks = pull?.checks ?? 'none';
    if (typeof checks === 'object') return { runs: checks.runs ?? [], status: { state: 'pending', total_count: (checks.statuses ?? []).length, statuses: checks.statuses ?? [] } };
    return { runs: RUNS[checks], status: checks === 'passing-status' ? { state: 'success', total_count: 1, statuses: [{ state: 'success', context: 'fixture' }] } : EMPTY_STATUS };
  };
  const apply = (pull, change) => {
    if (change.checks !== undefined) pull.checks = change.checks;
    if (change.mergeable !== undefined) pull.mergeable = change.mergeable;
    if (change.merged) Object.assign(pull, { merged: true, state: 'closed', mergedAt: new Date().toISOString(), mergeSha: createHash('sha1').update(`${pull.repo}#${pull.number}:${refresh(pull).headSha}`).digest('hex') });
    if (change.closed) pull.state = 'closed';
    return pull;
  };

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://fixture'); const method = request.method ?? 'GET'; const path = url.pathname;
    const text = await new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      request.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) { reject(new Error('Body too large.')); request.destroy(); } else chunks.push(chunk); });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); request.on('error', reject);
    });
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { return send(response, 400, { message: 'Problems parsing JSON' }); }
    const authorized = request.headers.authorization === `Bearer ${token}`;
    const control = /^\/_control\/pulls\/(\d+)$/.exec(path);
    if (!control) requests.push({ method, path, query: Object.fromEntries(url.searchParams), body, headers: { accept: request.headers.accept ?? null, apiVersion: request.headers['x-github-api-version'] ?? null,
      userAgent: request.headers['user-agent'] ?? null, contentType: request.headers['content-type'] ?? null, authorized } });
    if (path === '/_redirect' || path.startsWith('/_redirect/')) { response.writeHead(302, { location: `${path.slice('/_redirect'.length) || '/'}${url.search}` }); return response.end(); }
    if (!authorized) return send(response, 401, { message: 'Bad credentials' });
    if (control && method === 'POST') { try { return send(response, 200, view(apply(find(control[1], body?.repo), body ?? {}))); } catch (error) { return send(response, 404, { message: error.message }); } }
    const failure = failures.findIndex((entry) => entry.method === method && entry.path.test(path));
    if (failure >= 0) { const [entry] = failures.splice(failure, 1); return send(response, entry.status, entry.body); }
    const route = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    const repo = route && `${decodeURIComponent(route[1])}/${decodeURIComponent(route[2])}`;
    if (!route || !origin(repo)) return send(response, 404, { message: 'Not Found' });
    const rest = route[3]; const [owner] = repo.split('/'); let match;
    if (rest === '/pulls' && method === 'GET') {
      const head = url.searchParams.get('head'); const state = url.searchParams.get('state') ?? 'open';
      const ref = head && (head.includes(':') ? (head.startsWith(`${owner}:`) ? head.slice(owner.length + 1) : null) : head);
      if (head && ref === null) return send(response, 200, []);
      return send(response, 200, pulls.filter((pull) => pull.repo === repo && (state === 'all' || pull.state === state) && (!ref || pull.head === ref)).map((pull) => view(refresh(pull), true)));
    }
    if (rest === '/pulls' && method === 'POST') {
      const { title, head, base, body: description = '' } = body ?? {};
      if (typeof title !== 'string' || !title || typeof head !== 'string' || typeof base !== 'string' || typeof description !== 'string') return send(response, 422, { message: 'Validation Failed' });
      const ref = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head; const headSha = headOf(repo, ref);
      if (!headSha || !headOf(repo, base)) return send(response, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: headSha ? 'base' : 'head', code: 'invalid' }] });
      if (pulls.some((pull) => pull.repo === repo && pull.state === 'open' && pull.head === ref)) return send(response, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${owner}:${ref}.` }] });
      const pull = { repo, number: pulls.filter((entry) => entry.repo === repo).length + 1, title, body: description, head: ref, base, state: 'open', merged: false, mergedAt: null, mergeable: 'clean', checks: 'none', headSha, mergeSha: null };
      pulls.push(pull); return send(response, 201, view(pull));
    }
    if ((match = /^\/pulls\/(\d+)$/.exec(rest)) && method === 'GET') {
      const pull = pulls.find((entry) => entry.repo === repo && entry.number === Number(match[1]));
      return pull ? send(response, 200, view(refresh(pull))) : send(response, 404, { message: 'Not Found' });
    }
    if ((match = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const pull = pulls.find((entry) => entry.repo === repo && entry.number === Number(match[1]));
      if (!pull) return send(response, 404, { message: 'Not Found' });
      refresh(pull);
      if (pull.state !== 'open' || pull.mergeable === 'dirty') return send(response, 405, { message: NOT_MERGEABLE });
      if (body?.sha !== undefined && body.sha !== pull.headSha) return send(response, 409, { message: 'Head branch was modified. Review and try the merge again.' });
      apply(pull, { merged: true });
      return send(response, 200, { sha: pull.mergeSha, merged: true, message: 'Pull Request successfully merged' });
    }
    if ((match = /^\/commits\/([^/]+)\/check-runs$/.exec(rest)) && method === 'GET') {
      const { runs } = checksOf(repo, match[1]);
      return send(response, 200, { total_count: runs.length, check_runs: runs.map((run, index) => ({ id: index + 1, name: `fixture-${index + 1}`, head_sha: match[1], ...run })) });
    }
    if ((match = /^\/commits\/([^/]+)\/status$/.exec(rest)) && method === 'GET') return send(response, 200, { sha: match[1], ...checksOf(repo, match[1]).status });
    return send(response, 404, { message: 'Not Found' });
  }

  const server = createServer((request, response) => { handle(request, response).catch((error) => { if (!response.headersSent) send(response, 500, { message: error.message }); else response.destroy(); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, pulls,
    setChecks: (number, checks, repo) => { apply(find(number, repo), { checks }); },
    setMergeable: (number, mergeable, repo) => { apply(find(number, repo), { mergeable }); },
    markMerged: (number, repo) => { apply(find(number, repo), { merged: true }); },
    closePull: (number, repo) => { apply(find(number, repo), { closed: true }); },
    failNext: (method, path, status, message) => { failures.push({ method, path, status, body: typeof message === 'string' ? { message } : message }); },
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve())); },
  };
}

function send(response, status, value) {
  const text = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}
