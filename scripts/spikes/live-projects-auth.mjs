import { execFileSync } from 'node:child_process';
import { z } from 'zod';

export const LiveAuthenticationSchema = z.strictObject({ schema: z.literal('live-authentication-v1'),
  codex: z.enum(['api-key', 'subscription']), github: z.enum(['environment', 'gh']), repository: z.enum(['environment', 'argument']) });
export const TestInputSchema = z.union([z.string().regex(/^JEVELLAN_TEST_[A-Z_]+$/), z.literal('gh'), z.literal('codex')]);
export const LiveAuthenticationGapSchema = z.strictObject({ id: z.enum(['ENV-JEV', 'ENV-CODEX', 'ENV-GITHUB', 'ENV-CLAUDE', 'AUTH-GITHUB', 'AUTH-CODEX']),
  variables: z.array(TestInputSchema).min(1), reason: z.string().min(1).max(300) });
export const LiveAuthenticationVariablesSchema = z.record(TestInputSchema, z.enum(['present', 'missing', 'invalid']));
export const GapSchema = LiveAuthenticationGapSchema;
export const VariablesSchema = LiveAuthenticationVariablesSchema;

const NAMES = ['JEVELLAN_TEST_JEV_KEY', 'JEVELLAN_TEST_CODEX_KEY', 'JEVELLAN_TEST_GITHUB_TOKEN', 'JEVELLAN_TEST_GITHUB_REPO', 'JEVELLAN_TEST_CLAUDE_TOKEN'];
const REPOSITORY = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
const AUTH_FAILURE = 'The authorized gh login could not be verified or its GitHub token could not be read, so GitHub authentication is blocked.';

/**
 * Resolve only explicit live journey authentication choices. Secrets remain in the returned in-memory values.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [environment]
 * @param {(args: string[]) => string} [runGh]
 */
export function resolveLiveAuthentication(argv, environment = process.env, runGh) {
  const option = (name) => {
    const positions = argv.flatMap((value, index) => value === name ? [index] : []);
    if (!positions.length) return undefined;
    if (positions.length !== 1) throw new Error(`${name} may be given only once.`);
    const value = argv[positions[0] + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return value.trim();
  };
  const github = option('--github-auth') ?? 'environment';
  if (!['environment', 'gh'].includes(github)) throw new Error('--github-auth must be environment or gh.');
  const repository = option('--github-repo');
  const authentication = LiveAuthenticationSchema.parse({ schema: 'live-authentication-v1', codex: argv.includes('--codex-subscription') ? 'subscription' : 'api-key',
    github, repository: repository === undefined ? 'environment' : 'argument' });
  const values = Object.fromEntries(NAMES.map((name) => [name, environment[name]?.trim() ?? '']));
  if (repository !== undefined) values.JEVELLAN_TEST_GITHUB_REPO = repository;
  if (github === 'gh') values.JEVELLAN_TEST_GITHUB_TOKEN = '';
  const presence = (name) => !values[name] ? 'missing'
    : name === 'JEVELLAN_TEST_GITHUB_REPO' && (!REPOSITORY.test(values[name]) || values[name].endsWith('.git')) ? 'invalid' : 'present';
  const groups = [
    { id: 'ENV-JEV', required: true, variables: ['JEVELLAN_TEST_JEV_KEY'], without: 'placement cannot ask the real Jev' },
    { id: 'ENV-CODEX', required: authentication.codex === 'api-key', variables: ['JEVELLAN_TEST_CODEX_KEY'], without: 'no real Codex account can run the coordinator or the thread' },
    { id: 'ENV-GITHUB', required: true, variables: github === 'gh' ? ['JEVELLAN_TEST_GITHUB_REPO'] : ['JEVELLAN_TEST_GITHUB_TOKEN', 'JEVELLAN_TEST_GITHUB_REPO'], without: 'there is no disposable GitHub repository for the pull request' },
    { id: 'ENV-CLAUDE', required: false, variables: ['JEVELLAN_TEST_CLAUDE_TOKEN'], without: 'Claude stays off and only Codex runs' },
  ];
  const gap = (group) => {
    const missing = group.variables.filter((name) => presence(name) === 'missing');
    const invalid = group.variables.filter((name) => presence(name) === 'invalid');
    if (!missing.length && !invalid.length) return null;
    const parts = [...missing.length ? [`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`] : [],
      ...invalid.length ? [`${invalid.join(' and ')} is not in owner/repository form`] : []];
    return GapSchema.parse({ id: group.id, variables: [...missing, ...invalid], reason: `${parts.join(' and ')}, so ${group.without}.` });
  };
  const blockedBy = groups.filter((group) => group.required).map(gap).filter(Boolean);
  const optionalMissing = groups.filter((group) => group.id === 'ENV-CLAUDE').map(gap).filter(Boolean);
  let ghPresence = 'missing';
  if (github === 'gh' && !blockedBy.length) {
    const run = runGh ?? ((args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024,
      env: { ...Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('JEVELLAN_TEST_'))), GH_PROMPT_DISABLED: '1' } }));
    try {
      const login = run(['api', 'user', '--hostname', 'github.com', '--jq', '.login']).trim();
      if (!login) throw new Error('Missing GitHub login.');
      const token = run(['auth', 'token', '--hostname', 'github.com']).trim();
      if (!token) throw new Error('Missing GitHub token.');
      values.JEVELLAN_TEST_GITHUB_TOKEN = token; ghPresence = 'present';
    } catch {
      blockedBy.push(GapSchema.parse({ id: 'AUTH-GITHUB', variables: ['gh'], reason: AUTH_FAILURE }));
    }
  }
  const variables = VariablesSchema.parse({ ...Object.fromEntries(NAMES.map((name) => [name, presence(name)])), ...(github === 'gh' ? { gh: ghPresence } : {}) });
  return { authentication, values, variables, blockedBy, optionalMissing };
}
