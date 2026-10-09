import { useEffect, useRef, useState } from 'react';
import {
  AgentAccessCreatedSchema, AgentAccessListSchema, AgentConnectionSchema, ProjectsListSchema,
  type AgentConnection,
} from '@jevellan/core/client';
import { api, empty, isCancelled } from './api.js';
import { clientId } from './client-id.js';
import { Confirm, SectionHeading, dateTime, useTask, type PageProps } from './components.js';
import { Icon } from './icons.js';

export function AgentsPage(props: PageProps) {
  const [connections, setConnections] = useState<AgentConnection[]>();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [mcpUrl, setMcpUrl] = useState('');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [lifetime, setLifetime] = useState('30');
  const [issued, setIssued] = useState<{ id: string; label: string; token: string }>();
  const [revoke, setRevoke] = useState<AgentConnection>();
  const request = useRef<{ id: string; fingerprint: string; expiresAt?: string } | undefined>(undefined);
  const task = useTask(props.onError);
  const refresh = async (signal: AbortSignal) => {
    const value = await api('/api/agent-access', AgentAccessListSchema, 'GET', undefined, { signal, waitForHub: true });
    setConnections(value.connections);
    setMcpUrl(value.mcpUrl);
  };
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      refresh(controller.signal),
      api('/hub/projects', ProjectsListSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
        .then(value => setProjects(value.projects.map(row => ({ id: row.project.id, name: row.project.name })))),
    ]).catch(error => { if (!isCancelled(error)) props.onError(error); });
    return () => controller.abort();
  }, [props.onError]);
  const copy = (text: string, message: string) => {
    void task.run(async () => {
      await navigator.clipboard.writeText(text);
      props.message(message);
    });
  };
  const setup = JSON.stringify({
    mcpServers: { jevellan: { url: mcpUrl, headers: { Authorization: 'Bearer <connection token>' } } },
  }, null, 2);
  const stdio = JSON.stringify({
    mcpServers: { jevellan: { command: 'jevellan', args: ['mcp-server'], env: {
      JEVELLAN_MCP_URL: mcpUrl, JEVELLAN_MCP_TOKEN: '<connection token>',
    } } },
  }, null, 2);
  return <>
    <SectionHeading title="Agents" />
    <p className="intro">Connect another agent to Jevellan through MCP. It can start and steer work, follow project messages, and receive organized live output.</p>
    <section className="card">
      <h2>New connection</h2>
      <p>Give each agent its own connection. Choose the projects it can work with and how long access lasts.</p>
      <form onSubmit={event => {
        event.preventDefault();
        void task.run(async signal => {
          const fingerprint = JSON.stringify({ label: label.trim(), scope, selected, lifetime });
          if (request.current?.fingerprint !== fingerprint) request.current = {
            id: clientId(), fingerprint,
            ...(lifetime === 'never' ? {} : { expiresAt: new Date(Date.now() + Number(lifetime) * 86_400_000).toISOString() }),
          };
          const result = await api('/api/agent-access', AgentAccessCreatedSchema, 'POST', {
            schema: 'agent-access-create-v1', clientRequestId: request.current.id, label: label.trim(),
            ...(scope === 'selected' ? { projectIds: selected } : {}),
            ...(request.current.expiresAt ? { expiresAt: request.current.expiresAt } : {}),
          }, { signal, waitForHub: true });
          if (result.token) setIssued({ id: result.connection.id, label: result.connection.label, token: result.token });
          else props.message('This connection was already created. Its token is shown only once. Revoke it and create a new connection if you did not save the token.');
          setConnections(current => [result.connection, ...(current ?? []).filter(row => row.id !== result.connection.id)]);
          setLabel('');
          request.current = undefined;
        });
      }}>
        <label>Name<input value={label} maxLength={120} required placeholder="For example, my coding agent" disabled={task.busy || !!issued}
          onChange={event => setLabel(event.target.value)} /></label>
        <div className="form-grid">
          <label><span>Access</span><select aria-label="Access" value={scope} disabled={task.busy || !!issued} onChange={event => setScope(event.target.value)}>
            <option value="all">All projects and conversations</option><option value="selected">Selected projects</option>
          </select></label>
          <label><span>Expires</span><select aria-label="Expires" value={lifetime} disabled={task.busy || !!issued} onChange={event => setLifetime(event.target.value)}>
            <option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option><option value="never">No expiry</option>
          </select></label>
        </div>
        {scope === 'selected' && <fieldset className="agent-projects"><legend>Projects</legend>
          {!projects.length && <p className="muted">Add a project first.</p>}
          {projects.map(project => <label className="checkbox-label" key={project.id}>
            <input type="checkbox" checked={selected.includes(project.id)} disabled={task.busy || !!issued}
              onChange={event => setSelected(current => event.target.checked ? [...current, project.id] : current.filter(id => id !== project.id))} />
            {project.name}
          </label>)}
        </fieldset>}
        <button disabled={task.busy || !!issued || !connections || !label.trim() || (scope === 'selected' && !selected.length)}>
          {task.busy ? 'Working…' : 'Create connection'}
        </button>
      </form>
      {issued && <div className="agent-issued" role="status">
        <h3>Token for {issued.label}</h3>
        <p>Copy this token now. Jevellan will not show it again.</p>
        <label>Connection token<input type="password" autoComplete="off" readOnly value={issued.token} /></label>
        <div className="form-actions">
          <button type="button" disabled={task.busy} onClick={() => copy(issued.token, 'Connection token copied.')}><Icon name="copy" /> Copy token</button>
          <button type="button" className="secondary" onClick={() => setIssued(undefined)}>I saved it</button>
        </div>
      </div>}
    </section>
    <section className="card">
      <h2>Connections</h2>
      {!connections ? <p className="muted">Loading connections…</p> : !connections.length ? <p className="muted">No agents connected yet.</p> :
        <ul className="agent-connections">{connections.map(connection => {
          const status = connection.revokedAt ? 'Revoked' : connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now() ? 'Expired' : 'Active';
          const names = connection.projectIds?.map(id => projects.find(project => project.id === id)?.name ?? id).join(', ');
          return <li key={connection.id}>
            <div><strong>{connection.label}</strong><span className="chip">{status}</span>
              <p className="muted">{names ?? 'All projects and conversations'} · token ends in {connection.tokenSuffix}</p>
              <p className="muted small-text">Created {dateTime(connection.createdAt)}{connection.expiresAt && ` · Expires ${dateTime(connection.expiresAt)}`}</p>
            </div>
            {status === 'Active' && <button type="button" className="secondary" disabled={task.busy} onClick={() => setRevoke(connection)}>Revoke</button>}
          </li>;
        })}</ul>}
    </section>
    <section className="card">
      <h2>Connect your agent</h2>
      <p>Use the HTTP configuration below in a client that supports MCP. Replace the placeholder with your connection token.</p>
      <label>MCP address<input readOnly value={mcpUrl} /></label>
      <pre className="agent-config"><code>{setup}</code></pre>
      <button type="button" className="secondary" disabled={!mcpUrl || task.busy} onClick={() => copy(setup, 'MCP configuration copied.')}><Icon name="copy" /> Copy configuration</button>
      <details className="agent-stdio"><summary>For clients that require a local command</summary>
        <p>With Jevellan installed on the agent’s machine, use this configuration.</p>
        <pre className="agent-config"><code>{stdio}</code></pre>
        <button type="button" className="secondary" disabled={!mcpUrl || task.busy} onClick={() => copy(stdio, 'Local MCP configuration copied.')}><Icon name="copy" /> Copy local configuration</button>
      </details>
      <p className="muted">Work can use Auto choices or select a provider, account, model and effort. The agent can discover available choices and follow messages from jobs, threads and coordinators.</p>
    </section>
    {revoke && <Confirm title={`Revoke ${revoke.label}?`} action="Revoke connection" danger busy={task.busy} close={() => setRevoke(undefined)}
      confirm={() => { void task.run(async signal => {
        const result = await api(`/api/agent-access/${encodeURIComponent(revoke.id)}/revoke`, AgentConnectionSchema, 'POST', empty, { signal, waitForHub: true });
        setConnections(current => current?.map(row => row.id === result.id ? result : row));
        if (issued?.id === result.id) setIssued(undefined);
        setRevoke(undefined);
        props.message('Connection revoked.');
      }); }}>
      <p>This agent will lose access. Work it already started keeps running.</p>
    </Confirm>}
  </>;
}
