import { useEffect, useState } from 'react';
import { z } from 'zod';
import { GitCheckSchema, GitSettingsSchema, ProjectsListSchema } from '@jevellan/core/client';
import { api } from './api.js';
import { SectionHeading, useTask, type PageProps } from './components.js';

export function GitPage(props: PageProps) {
  const [settings, setSettings] = useState<z.infer<typeof GitSettingsSchema>>();
  const [transport, setTransport] = useState<'machine' | 'ssh'>('machine');
  const [projectId, setProjectId] = useState('');
  const [result, setResult] = useState<z.infer<typeof GitCheckSchema>>();
  const [allProjects, setProjects] = useState<z.infer<typeof ProjectsListSchema>['projects']>([]);
  const task = useTask(props.onError);
  const deviceId = props.data.devices.currentDeviceId;
  const device = props.data.devices.devices.find(row => row.id === deviceId)?.name ?? 'this device';
  const projects = allProjects.filter(row => row.project.paths[deviceId] && (!row.project.allowedDevices || row.project.allowedDevices.includes(deviceId)));
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/git/settings', GitSettingsSchema, 'GET', undefined, { signal: controller.signal }).then(value => { setSettings(value); setTransport(value.githubTransport); }).catch(props.onError);
    void api('/hub/projects', ProjectsListSchema, 'GET', undefined, { signal: controller.signal }).then(value => setProjects(value.projects)).catch(props.onError);
    return () => controller.abort();
  }, [deviceId, props.onError]);
  const selected = projectId || projects[0]?.project.id;
  return <><SectionHeading title="Git"/><p className="intro">Connect project repositories on {device}. Agent accounts and Git authentication are separate.</p>
    <section className="card"><h2>GitHub connection</h2><p>Jevellan runs Git in the background. A login that needs a terminal prompt or a locked macOS Keychain cannot complete there.</p>
      <form onSubmit={event => { event.preventDefault(); void task.run(async signal => { const saved = await api('/api/git/settings', GitSettingsSchema, 'PUT', { ...settings!, githubTransport: transport }, { signal }); setSettings(saved); setResult(undefined); props.message(`Git settings saved on ${device}. Check your project, then retry the blocked operation.`); }); }}>
        <label>Connection method<select disabled={!settings || task.busy} value={transport} onChange={event => { setTransport(event.target.value as 'machine' | 'ssh'); setResult(undefined); }}><option value="machine">Use this machine's Git configuration</option><option value="ssh">Use SSH for GitHub</option></select></label>
        <p className="muted">{transport === 'ssh' ? 'Use an existing GitHub SSH key available on this device. HTTPS GitHub remotes are connected over SSH for Jevellan’s Git operations.' : 'Use the credential helper or SSH configuration already set up on this device. HTTPS credentials must be available without an interactive prompt.'}</p>
        <p className="muted small-text">This choice is saved only in Jevellan on {device}. Repository URLs, global Git settings and native logins are left unchanged.</p>
        <button disabled={!settings || task.busy || transport === settings.githubTransport}>{task.busy ? 'Working…' : 'Save Git settings'}</button>
      </form>
    </section>
    <section className="card"><h2>Check a project</h2><p>Test read access using the saved connection method. This check does not fetch, commit or push.</p>
      {projects.length ? <><label>Project<select value={selected} disabled={task.busy} onChange={event => { setProjectId(event.target.value); setResult(undefined); }}>{projects.map(row => <option key={row.project.id} value={row.project.id}>{row.project.name}</option>)}</select></label>
        <button className="secondary" disabled={!settings || task.busy || transport !== settings.githubTransport} onClick={() => void task.run(async signal => { setResult(undefined); setResult(await api('/api/git/check', GitCheckSchema, 'POST', { schema: 'git-check-request-v1', projectId: selected }, { signal })); })}>{task.busy ? 'Checking…' : 'Check connection'}</button>
        {settings && transport !== settings.githubTransport && <p className="muted">Save the connection method before checking.</p>}
      </> : <p>Add a project with a checkout on this device in <button className="text-button" onClick={() => props.navigate('/settings/projects')}>Projects</button>.</p>}
      {result && <div className="git-check-result" role="status"><h3>{result.status === 'ready' ? 'Connected' : result.status === 'local' ? 'Local checkout' : 'Connection needs attention'}</h3>{result.remote && <p><code style={{ overflowWrap: 'anywhere' }}>{result.remote}</code></p>}<p>{result.message}</p>{result.status === 'failed' && <p className="muted">For SSH, the existing key must be available to this device and registered with GitHub. For HTTPS, finish signing in to the machine's credential helper, then check again.</p>}</div>}
    </section>
  </>;
}
