// Fake GitHub REST server (API version 2022-11-28 shapes) for pull request tests. Plain node:http on an ephemeral port.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const RUNS = { none: [], pending: [{ status: 'queued', conclusion: null }], passing: [{ status: 'completed', conclusion: 'success' }], 'passing-status': [], failing: [{ status: 'completed', conclusion: 'failure' }] };
// GitHub's combined status when no commit status exists: `pending` with zero entries.
const EMPTY_STATUS = { state: 'pending', total_count: 0, statuses: [] };
const MERGEABLE = { clean: true, unstable: true, dirty: false, unknown: null };
const NOT_MERGEABLE = 'Pull Request is not mergeable';

export async function startGitHubFixture({ token, repositories = {}, port = 0, onMerge }) {
  if (typeof token !== 'string' || !token) throw new Error('The GitHub fixture needs a token.');
  const workflowView = value => { const { jobs, repo, workflow, ...run } = value; void jobs; void repo; return { name: workflow, ...run }; };
  const requests = []; const pulls = []; const failures = []; const workflows = []; const variables = new Map(); let loseDispatchReply = false;
  const origin = (repo) => repositories[repo];
  const headOf = (repo, ref) => {
    try { return execFileSync('git', ['--git-dir', origin(repo), 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
  };
  // Force pushes move the head: re-read it from the bare origin on every call.
  const refresh = (pull) => { const sha = headOf(pull.repo, pull.head); if (sha) { pull.headSha = sha; execFileSync('git', ['--git-dir', origin(pull.repo), 'update-ref', `refs/pull/${pull.number}/head`, sha]); } return pull; };
  const find = (number, repo = Object.keys(repositories)[0]) => {
    const pull = pulls.find((entry) => entry.repo === repo && entry.number === Number(number));
    if (!pull) throw new Error(`No fixture pull request ${repo}#${number}.`);
    return pull;
  };
  const view = (pull, list = false) => {
    const [owner] = pull.repo.split('/');
    return { number: pull.number, html_url: `https://github.com/${pull.repo}/pull/${pull.number}`, state: pull.state, title: pull.title, body: pull.body,
      user: { login: pull.author ?? owner }, draft: pull.draft ?? false, updated_at: pull.updatedAt ?? new Date().toISOString(),
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
    if ((match = /^\/actions\/variables\/([^/]+)$/.exec(rest)) && method === 'GET') return variables.has(match[1]) ? send(response, 200, { name: match[1], value: variables.get(match[1]) }) : send(response, 404, { message: 'Variable not found' });
    if (rest === '/git/matching-refs/heads/jv/jobs/' && method === 'GET') {
      const refs = execFileSync('git', ['--git-dir', origin(repo), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/jv/jobs/'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => { const [ref, sha] = line.split(' '); return { ref, object: { sha } }; });
      return send(response, 200, refs);
    }
    if ((match = /^\/git\/refs\/heads\/(jv\/jobs\/[A-Za-z0-9_-]+)$/.exec(rest)) && method === 'DELETE') { execFileSync('git', ['--git-dir', origin(repo), 'update-ref', '-d', `refs/heads/${match[1]}`]); response.writeHead(204); return response.end(); }
    if (rest === '/git/refs' && method === 'POST') {
      if (!/^refs\/heads\/jv\/jobs\/[A-Za-z0-9_-]+$/.test(body?.ref ?? '') || !/^[a-f0-9]{40}$/.test(body?.sha ?? '')) return send(response, 422, { message: 'Invalid ref' });
      try { execFileSync('git', ['--git-dir', origin(repo), 'update-ref', body.ref, body.sha, ''], { stdio: 'ignore' }); } catch { return send(response, 422, { message: 'Reference already exists' }); }
      return send(response, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((match = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest)) && method === 'POST') {
      const head = headOf(repo, body?.ref); if (!head) return send(response, 422, { message: 'Invalid ref' });
      const id = workflows.length + 1, at = new Date().toISOString();
      workflows.push({ repo, workflow: decodeURIComponent(match[1]), id, html_url: `https://github.com/${repo}/actions/runs/${id}`, display_title: `${decodeURIComponent(match[1])} ${body?.inputs?.sha ?? ''}`, head_sha: head, head_branch: body.ref, event: 'workflow_dispatch', status: 'queued', conclusion: null, created_at: at, run_started_at: at, jobs: [] });
      if (loseDispatchReply) { loseDispatchReply = false; response.destroy(); return; }
      return send(response, 200, { workflow_run_id: id, html_url: `https://github.com/${repo}/actions/runs/${id}` });
    }
    if (((match = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest)) || rest === '/actions/runs') && method === 'GET') {
      const runs = workflows.filter(run => run.repo === repo && (!match || run.workflow === decodeURIComponent(match[1]))
        && ['branch', 'event', 'status'].every(key => !url.searchParams.has(key) || run[key === 'branch' ? 'head_branch' : key] === url.searchParams.get(key))).sort((a, b) => b.id - a.id);
      const page = Number(url.searchParams.get('page') ?? '1'), size = Number(url.searchParams.get('per_page') ?? '100');
      return send(response, 200, { workflow_runs: runs.slice((page - 1) * size, page * size).map(workflowView) });
    }
    if ((match = /^\/actions\/runs\/(\d+)(\/jobs)?$/.exec(rest)) && method === 'GET') {
      const run = workflows.find(run => run.repo === repo && run.id === Number(match[1])); if (!run) return send(response, 404, { message: 'Not Found' });
      if (match[2]) return send(response, 200, { total_count: run.jobs.length, jobs: run.jobs });
      return send(response, 200, workflowView(run));
    }
    if ((match = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest)) && method === 'GET') {
      const job = workflows.filter(run => run.repo === repo).flatMap(run => run.jobs).find(job => job.id === Number(match[1])); if (!job || job.logs === undefined) return send(response, 403, { message: 'Logs not readable' });
      response.writeHead(200, { 'content-type': 'text/plain' }); return response.end(job.logs);
    }
    if ((match = /^\/actions\/jobs\/(\d+)$/.exec(rest)) && method === 'GET') {
      const run = workflows.find(run => run.repo === repo && run.jobs.some(job => job.id === Number(match[1])));
      return run ? send(response, 200, { id: Number(match[1]), run_id: run.id }) : send(response, 404, { message: 'Not Found' });
    }
    if (rest === '/pulls' && method === 'GET') {
      const head = url.searchParams.get('head'); const state = url.searchParams.get('state') ?? 'open';
      const ref = head && (head.includes(':') ? (head.startsWith(`${owner}:`) ? head.slice(owner.length + 1) : null) : head);
      if (head && ref === null) return send(response, 200, []);
      return send(response, 200, pulls.filter((pull) => pull.repo === repo && (state === 'all' || pull.state === state) && (!ref || pull.head === ref))
        .slice(0, Number(url.searchParams.get('per_page') ?? pulls.length)).map((pull) => view(refresh(pull), true)));
    }
    if (rest === '/pulls' && method === 'POST') {
      const { title, head, base, body: description = '' } = body ?? {};
      if (typeof title !== 'string' || !title || typeof head !== 'string' || typeof base !== 'string' || typeof description !== 'string') return send(response, 422, { message: 'Validation Failed' });
      const ref = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head; const headSha = headOf(repo, ref);
      if (!headSha || !headOf(repo, base)) return send(response, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: headSha ? 'base' : 'head', code: 'invalid' }] });
      if (pulls.some((pull) => pull.repo === repo && pull.state === 'open' && pull.head === ref)) return send(response, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${owner}:${ref}.` }] });
      const pull = { repo, number: pulls.filter((entry) => entry.repo === repo).length + 1, title, body: description, head: ref, base, state: 'open', merged: false, mergedAt: null, mergeable: 'clean', checks: 'none', headSha, mergeSha: null };
      execFileSync('git', ['--git-dir', origin(repo), 'update-ref', `refs/pull/${pull.number}/head`, headSha]);
      pulls.push(pull); return send(response, 201, view(pull));
    }
    if ((match = /^\/pulls\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      const pull = refresh(find(match[1], repo));
      if (body?.state !== 'closed') return send(response, 422, { message: 'Expected a close request.' });
      apply(pull, { closed: true }); return send(response, 200, view(pull));
    }
    if ((match = /^\/pulls\/(\d+)$/.exec(rest)) && method === 'GET') {
      const pull = pulls.find((entry) => entry.repo === repo && entry.number === Number(match[1]));
      return pull ? send(response, 200, view(refresh(pull))) : send(response, 404, { message: 'Not Found' });
    }
    if ((match = /^\/pulls\/(\d+)\/files$/.exec(rest)) && method === 'GET') {
      const pull = refresh(find(match[1], repo));
      const diff = args => execFileSync('git', ['--git-dir', origin(repo), 'diff', ...args, `${pull.base}...${pull.headSha}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      const files = diff(['--numstat']).trim().split('\n').filter(Boolean).map(line => {
        const [added, removed, filename] = line.split('\t');
        const patch = execFileSync('git', ['--git-dir', origin(repo), 'diff', `${pull.base}...${pull.headSha}`, '--', filename], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        return { filename, status: 'modified', additions: Number(added) || 0, deletions: Number(removed) || 0, patch };
      });
      const page = Number(url.searchParams.get('page') ?? '1'); return send(response, 200, files.slice((page - 1) * 100, page * 100));
    }
    if ((match = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const pull = pulls.find((entry) => entry.repo === repo && entry.number === Number(match[1]));
      if (!pull) return send(response, 404, { message: 'Not Found' });
      refresh(pull);
      if (pull.state !== 'open' || pull.mergeable === 'dirty') return send(response, 405, { message: NOT_MERGEABLE });
      if (body?.sha !== undefined && body.sha !== pull.headSha) return send(response, 409, { message: 'Head branch was modified. Review and try the merge again.' });
      // A real merge reaches the base before other clients can observe `merged`.
      const mergedSha = await onMerge?.(pull);
      apply(pull, { merged: true });
      if (mergedSha) pull.mergeSha = mergedSha;
      return send(response, 200, { sha: pull.mergeSha, merged: true, message: 'Pull Request successfully merged' });
    }
    if ((match = /^\/commits\/([^/]+)\/check-runs$/.exec(rest)) && method === 'GET') {
      const { runs } = checksOf(repo, match[1]);
      return send(response, 200, { total_count: runs.length, check_runs: runs.map((run, index) => ({ id: index + 1, name: `fixture-${index + 1}`, head_sha: match[1], ...run })) });
    }
    if ((match = /^\/commits\/([^/]+)\/status$/.exec(rest)) && method === 'GET') return send(response, 200, { sha: match[1], ...checksOf(repo, match[1]).status });
    if ((match = /^\/commits\/([^/]+)\/pulls$/.exec(rest)) && method === 'GET') return send(response, 200,
      pulls.filter(pull => pull.repo === repo && (pull.headSha === match[1] || pull.mergeSha === match[1])).map(pull => view(pull, true)));
    if (rest === '/commits' && method === 'GET') {
      const args = ['--git-dir', origin(repo), 'rev-list', `--max-count=${Math.min(30, Number(url.searchParams.get('per_page') ?? '10'))}`];
      if (url.searchParams.get('since')) args.push(`--since=${url.searchParams.get('since')}`);
      const shas = execFileSync('git', [...args, '--end-of-options', url.searchParams.get('sha') ?? 'main'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      return send(response, 200, shas.map(sha => {
        const [name, date, ...message] = execFileSync('git', ['--git-dir', origin(repo), 'show', '-s', '--format=%an%n%aI%n%B', sha], { encoding: 'utf8' }).split('\n');
        return { sha, commit: { message: message.join('\n'), author: { name, date: new Date(date).toISOString() } } };
      }));
    }
    return send(response, 404, { message: 'Not Found' });
  }

  const server = createServer((request, response) => { handle(request, response).catch((error) => { if (!response.headersSent) send(response, 500, { message: error.message }); else response.destroy(); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, pulls, workflows,
    loseNextDispatchReply: () => { loseDispatchReply = true; },
    setVariable: (name, value) => { if (value === undefined) variables.delete(name); else variables.set(name, value); },
    addWorkflow: value => { const id = workflows.length + 1; const run = { repo: Object.keys(repositories)[0], workflow: 'nightly.yml', id, html_url: `https://github.com/fixture/repo/actions/runs/${id}`, head_sha: headOf(Object.keys(repositories)[0], 'main'), head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), jobs: [], ...value }; workflows.push(run); return run; },
    changeWorkflow: (id, patch) => { const run = workflows.find(row => row.id === id); if (!run) throw new Error('Workflow missing.'); Object.assign(run, patch); return run; },
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
