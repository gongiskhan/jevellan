import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GapSchema, LiveAuthenticationSchema, VariablesSchema, resolveLiveAuthentication } from '../scripts/spikes/live-projects-auth.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const legacy = () => ({ JEVELLAN_TEST_JEV_KEY: 'fixture-jev', JEVELLAN_TEST_CODEX_KEY: 'fixture-codex', JEVELLAN_TEST_GITHUB_TOKEN: 'fixture-github',
  JEVELLAN_TEST_GITHUB_REPO: 'fixture/disposable', JEVELLAN_TEST_CLAUDE_TOKEN: 'fixture-claude' });
const ghFlags = ['--codex-subscription', '--github-auth', 'gh'];
const publicResult = (result: ReturnType<typeof resolveLiveAuthentication>) => JSON.stringify({ authentication: result.authentication, variables: result.variables,
  blockedBy: result.blockedBy, optionalMissing: result.optionalMissing });

test('legacy environment credentials retain their requirements and never invoke gh', () => {
  const environment = { ...legacy(), JEVELLAN_TEST_JEV_KEY: ' fixture-jev \n' }; const original = { ...environment }; const gh = vi.fn();
  const result = resolveLiveAuthentication([], environment, gh);
  expect(result.authentication).toEqual({ schema: 'live-authentication-v1', codex: 'api-key', github: 'environment', repository: 'environment' });
  expect(result.values).toEqual(legacy()); expect(result.blockedBy).toEqual([]); expect(result.optionalMissing).toEqual([]);
  expect(Object.values(result.variables)).toEqual(Array(5).fill('present')); expect(gh).not.toHaveBeenCalled(); expect(environment).toEqual(original);
});

test('missing legacy inputs remain blocked and missing Claude remains optional', () => {
  const result = resolveLiveAuthentication([], {}, vi.fn());
  expect(result.blockedBy.map((gap) => gap!.id)).toEqual(['ENV-JEV', 'ENV-CODEX', 'ENV-GITHUB']);
  expect(result.blockedBy[2]?.variables).toEqual(['JEVELLAN_TEST_GITHUB_TOKEN', 'JEVELLAN_TEST_GITHUB_REPO']);
  expect(result.optionalMissing.map((gap) => gap!.id)).toEqual(['ENV-CLAUDE']);
});

test('subscription mode needs no Codex API key and does not claim its presence', () => {
  const environment: Record<string, string | undefined> = { ...legacy() };
  delete environment.JEVELLAN_TEST_CODEX_KEY; delete environment.JEVELLAN_TEST_CLAUDE_TOKEN;
  const result = resolveLiveAuthentication(['--codex-subscription'], environment, vi.fn());
  expect(result.authentication.codex).toBe('subscription'); expect(result.blockedBy).toEqual([]);
  expect(result.values.JEVELLAN_TEST_CODEX_KEY).toBe(''); expect(result.variables.JEVELLAN_TEST_CODEX_KEY).toBe('missing');
  expect(result.optionalMissing.map((gap) => gap!.id)).toEqual(['ENV-CLAUDE']);
});

test('an explicit repository overrides the environment without changing legacy authentication', () => {
  const result = resolveLiveAuthentication(['--github-repo', ' selected/sandbox '], { ...legacy(), JEVELLAN_TEST_GITHUB_REPO: 'invalid' }, vi.fn());
  expect(result.authentication.repository).toBe('argument'); expect(result.values.JEVELLAN_TEST_GITHUB_REPO).toBe('selected/sandbox');
  expect(result.variables.JEVELLAN_TEST_GITHUB_REPO).toBe('present'); expect(result.blockedBy).toEqual([]);
});

test.each(['invalid', '/sandbox', 'fixture/', 'fixture/..', 'fixture/sandbox.git', 'https://github.com/fixture/sandbox'])('malformed explicit repository %s remains blocked before gh runs', (repository) => {
  const gh = vi.fn(); const result = resolveLiveAuthentication([...ghFlags, '--github-repo', repository], legacy(), gh);
  expect(result.blockedBy).toMatchObject([{ id: 'ENV-GITHUB', variables: ['JEVELLAN_TEST_GITHUB_REPO'] }]);
  expect(result.variables.JEVELLAN_TEST_GITHUB_REPO).toBe('invalid'); expect(gh).not.toHaveBeenCalled();
});

test('gh mode verifies the login before reading its token and never falls back to the environment token', () => {
  const gh = vi.fn<(args: string[]) => string>().mockReturnValueOnce('fixture-user\n').mockReturnValueOnce(' fixture-resolved-token\n');
  const result = resolveLiveAuthentication(ghFlags, legacy(), gh);
  expect(gh.mock.calls.map(([args]) => args)).toEqual([['api', 'user', '--hostname', 'github.com', '--jq', '.login'], ['auth', 'token', '--hostname', 'github.com']]);
  expect(result.authentication.github).toBe('gh'); expect(result.values.JEVELLAN_TEST_GITHUB_TOKEN).toBe('fixture-resolved-token');
  expect(result.variables).toMatchObject({ gh: 'present', JEVELLAN_TEST_GITHUB_TOKEN: 'present' }); expect(result.blockedBy).toEqual([]);
  expect(publicResult(result)).not.toContain('fixture-resolved-token'); expect(publicResult(result)).not.toContain('fixture-github');
});

test.each(['api-failure', 'missing-executable', 'empty-login', 'token-failure', 'empty-token'])('gh %s becomes a constant safe authentication blocker', (failure) => {
  const secret = 'fixture-private-error-token';
  const gh = vi.fn<(args: string[]) => string>((args) => {
    if (failure === 'missing-executable') throw Object.assign(new Error(`spawn gh ENOENT ${secret}`), { code: 'ENOENT' });
    if (args[0] === 'api') { if (failure === 'api-failure') throw new Error(secret); return failure === 'empty-login' ? '\n' : 'fixture-user'; }
    if (failure === 'token-failure') throw new Error(secret);
    return failure === 'empty-token' ? ' \n ' : secret;
  });
  const result = resolveLiveAuthentication(ghFlags, legacy(), gh);
  expect(result.blockedBy).toMatchObject([{ id: 'AUTH-GITHUB', variables: ['gh'] }]);
  expect(result.values.JEVELLAN_TEST_GITHUB_TOKEN).toBe(''); expect(result.variables.gh).toBe('missing');
  expect(publicResult(result)).not.toContain(secret); expect(publicResult(result)).not.toContain('ENOENT');
  expect(result.blockedBy[0]?.reason).toBe('The authorized gh login could not be verified or its GitHub token could not be read, so GitHub authentication is blocked.');
  if (['api-failure', 'missing-executable', 'empty-login'].includes(failure)) expect(gh).toHaveBeenCalledOnce();
});

test.each(['JEVELLAN_TEST_JEV_KEY', 'JEVELLAN_TEST_GITHUB_REPO'])('another missing required input %s prevents any gh call', (name) => {
  const gh = vi.fn(); const result = resolveLiveAuthentication(ghFlags, { ...legacy(), [name]: '' }, gh);
  expect(result.blockedBy).toHaveLength(1); expect(result.blockedBy[0]?.variables).toContain(name); expect(gh).not.toHaveBeenCalled();
});

test('a missing API key still prevents gh when subscription mode was not requested', () => {
  const gh = vi.fn(); const result = resolveLiveAuthentication(['--github-auth', 'gh'], { ...legacy(), JEVELLAN_TEST_CODEX_KEY: '' }, gh);
  expect(result.blockedBy).toMatchObject([{ id: 'ENV-CODEX' }]); expect(gh).not.toHaveBeenCalled();
});

test.each([['--github-auth', 'unexpected-private-value'], ['--github-auth'], ['--github-auth', '--codex-subscription'], ['--github-auth', 'gh', '--github-auth', 'environment']])('invalid explicit authentication arguments are refused safely: %j', (...args) => {
  const gh = vi.fn(); expect(() => resolveLiveAuthentication(args, legacy(), gh)).toThrow(/--github-auth/); expect(gh).not.toHaveBeenCalled();
  try { resolveLiveAuthentication(args, legacy(), gh); } catch (error) { expect(String(error)).not.toContain('unexpected-private-value'); }
});

test('authentication and receipt schemas validate versions, modes and the gh input', () => {
  expect(LiveAuthenticationSchema.safeParse({ schema: 'live-authentication-v0', codex: 'subscription', github: 'gh', repository: 'argument' }).success).toBe(false);
  expect(LiveAuthenticationSchema.safeParse({ schema: 'live-authentication-v1', codex: 'native', github: 'gh', repository: 'argument' }).success).toBe(false);
  expect(GapSchema.safeParse({ id: 'AUTH-GITHUB', variables: ['gh'], reason: 'Fixture authentication failure.' }).success).toBe(true);
  expect(VariablesSchema.safeParse({ gh: 'missing', JEVELLAN_TEST_GITHUB_TOKEN: 'present' }).success).toBe(true);
});

test('subscription sign-in blockers validate independently of legacy API-key and gh blockers', () => {
  const gap = { id: 'AUTH-CODEX', variables: ['codex'], reason: 'The isolated Codex subscription account is not signed in.' };
  expect(GapSchema.parse(gap)).toEqual(gap);
  expect(VariablesSchema.parse({ codex: 'missing', gh: 'present', JEVELLAN_TEST_CODEX_KEY: 'missing' })).toEqual({ codex: 'missing', gh: 'present', JEVELLAN_TEST_CODEX_KEY: 'missing' });
  expect(GapSchema.safeParse({ ...gap, variables: ['native-codex'] }).success).toBe(false);
  expect(GapSchema.safeParse({ id: 'ENV-CODEX', variables: ['JEVELLAN_TEST_CODEX_KEY'], reason: 'The dedicated API key is missing.' }).success).toBe(true);
  expect(GapSchema.safeParse({ id: 'AUTH-GITHUB', variables: ['gh'], reason: 'Fixture authentication failure.' }).success).toBe(true);
});

test('the default gh process uses only the supplied isolated login context and privately captures output', () => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-live-auth-')); roots.push(root);
  const bin = join(root, 'bin'); const home = join(root, 'user'); const config = join(root, 'gh');
  for (const path of [bin, home, config]) mkdirSync(path);
  const AuthenticationSchema = z.strictObject({ schema: z.literal('fixture-gh-authentication-v1'), login: z.string(), token: z.string() });
  const authentication = AuthenticationSchema.parse({ schema: 'fixture-gh-authentication-v1', login: 'fixture-user', token: 'fixture-process-token' });
  const authFile = join(config, 'authentication.json'); const before = JSON.stringify(authentication); writeFileSync(authFile, before);
  const callsFile = join(root, 'calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nconst configuration=JSON.parse(fs.readFileSync(process.env.GH_CONFIG_DIR+'/authentication.json','utf8'));\nfs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({schema:'fixture-gh-call-v1',args,home:process.env.HOME,config:process.env.GH_CONFIG_DIR,prompt:process.env.GH_PROMPT_DISABLED,testVariables:Object.keys(process.env).filter(name=>name.startsWith('JEVELLAN_TEST_'))})+'\\n');\nprocess.stderr.write('private '+configuration.token);\nif(args[0]==='api')process.stdout.write(configuration.login+'\\n');else if(args[0]==='auth')process.stdout.write(configuration.token+'\\n');else process.exit(1);\n`, { mode: 0o700 });
  const environment = { ...legacy(), PATH: bin, HOME: home, GH_CONFIG_DIR: config, JEVELLAN_TEST_EXTRA: 'fixture-excluded' }; const copy = { ...environment };
  const result = resolveLiveAuthentication(ghFlags, environment);
  expect(result.blockedBy).toEqual([]); expect(result.values.JEVELLAN_TEST_GITHUB_TOKEN).toBe(authentication.token); expect(publicResult(result)).not.toContain(authentication.token);
  const CallSchema = z.strictObject({ schema: z.literal('fixture-gh-call-v1'), args: z.array(z.string()), home: z.string(), config: z.string(), prompt: z.string(), testVariables: z.array(z.string()) });
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => CallSchema.parse(JSON.parse(line)));
  expect(calls).toHaveLength(2); expect(calls.map((call) => call.args[0])).toEqual(['api', 'auth']);
  expect(calls.every((call) => call.home === home && call.config === config && call.prompt === '1' && call.testVariables.length === 0)).toBe(true);
  expect(readFileSync(authFile, 'utf8')).toBe(before); expect(environment).toEqual(copy);
});

test('a missing default gh executable stays blocked without accessing another login context', () => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-live-auth-missing-')); roots.push(root);
  const result = resolveLiveAuthentication(ghFlags, { ...legacy(), PATH: root, HOME: root, GH_CONFIG_DIR: root });
  expect(result.blockedBy).toMatchObject([{ id: 'AUTH-GITHUB', variables: ['gh'] }]); expect(result.values.JEVELLAN_TEST_GITHUB_TOKEN).toBe('');
  expect(publicResult(result)).not.toContain(root);
});
