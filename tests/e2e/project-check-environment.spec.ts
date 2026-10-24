import { expect, test } from './fixtures.js';
import { projectFixture } from '../helpers/project-fixture.js';

test('ENV1 check inputs save independently of work inputs', async ({ page, context }, info) => {
  const f = await projectFixture({ control: true });
  try {
    const base = (await f.app.projectWork.settingsView('project')).settings;
    await f.app.projectHub.putSettings({ ...base, environment: { variables: [{ name: 'WORK_LABEL', value: 'work-only' }], secrets: ['SAME_SECRET'], copyFiles: [] } }, base.revision);
    await f.app.state.environment.put('project', 'SAME_SECRET', 'synthetic-work-only-value');
    const split = f.cookie.indexOf('=');
    await context.addCookies([{ name: f.cookie.slice(0, split), value: f.cookie.slice(split + 1), url: f.base, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(f.base + '/projects/project/settings#project-settings-environment');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('check-environment-initial.png'), fullPage: true });
    const checks = page.getByRole('group', { name: 'Check environment', exact: true });
    await expect(checks).toBeVisible({ timeout: 10000 });
    await checks.getByRole('checkbox', { name: 'Use a separate check environment', exact: true }).check();
    const variable = checks.getByRole('button', { name: 'Add check variable', exact: true });
    await expect(variable).toBeEnabled(); await variable.click();
    await checks.getByRole('textbox', { name: 'Check variable name 1', exact: true }).fill('CHECK_LABEL');
    await checks.getByRole('textbox', { name: 'Check variable value 1', exact: true }).fill('check-only');
    const secret = checks.getByRole('button', { name: 'Add check secret', exact: true });
    await expect(secret).toBeEnabled(); await secret.click();
    await checks.getByRole('textbox', { name: 'Check secret name 1', exact: true }).fill('SAME_SECRET');
    await checks.getByLabel('Check secret value 1', { exact: true }).fill('synthetic-check-only-value');
    await checks.getByRole('textbox', { name: 'Check files', exact: true }).fill('fixtures/check.env => .env.local');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath('check-environment-separated-inputs.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(f.base + '/projects/project');
    const saved = (await f.app.projectWork.settingsView('project')).settings;
    expect(saved.environment).toEqual({ variables: [{ name: 'WORK_LABEL', value: 'work-only' }], secrets: ['SAME_SECRET'], copyFiles: [] });
    expect(saved.checkEnvironment).toEqual({ schema: 'project-check-environment-v1', variables: [{ name: 'CHECK_LABEL', value: 'check-only' }], secrets: ['SAME_SECRET'], copyFiles: [{ source: 'fixtures/check.env', target: '.env.local' }] });
    const workSecret = await f.app.state.environment.credentials('project'), checkSecret = await f.app.state.environment.credentials('project', 'check');
    expect(workSecret.SAME_SECRET === 'synthetic-work-only-value').toBe(true);
    expect(checkSecret.SAME_SECRET === 'synthetic-check-only-value').toBe(true);
    const editor = await (await f.request('/api/projects/project/config/editor')).json();
    expect(JSON.stringify(editor).includes('synthetic-work-only-value')).toBe(false);
    expect(JSON.stringify(editor).includes('synthetic-check-only-value')).toBe(false);
    expect(f.fake.runs).toHaveLength(0);
  } finally { await f.close(); }
});
