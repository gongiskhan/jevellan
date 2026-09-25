import { ProjectsListSchema } from '@jevellan/core/client';
import { api } from './api.js';
import { useTask, type PageProps } from './components.js';
import { JevConnection } from './jev-connection.js';
import { RuntimesPage } from './runtimes.js';
import { ProjectsPage } from './projects.js';
import { NewConversation } from './conversations.js';

const steps = [
  { id: 'jev', label: 'Jev key', title: 'Connect Jev', explanation: 'Add your Jev key to let it choose each next step, or skip to choose steps yourself.' },
  { id: 'account', label: 'Account', title: 'Add your first account', explanation: 'Choose a runtime and sign in with an account Jevellan can use.' },
  { id: 'project', label: 'Project', title: 'Add your first project', explanation: 'Choose a project already checked out on this device.' },
  { id: 'conversation', label: 'Conversation', title: 'Start your first conversation', explanation: 'Describe what you want to build or fix in that project.' },
] as const;

export function SetupPage(props: PageProps & { path: string }) {
  const selected = new URLSearchParams(props.path.split('?')[1]).get('step');
  const index = Math.max(0, steps.findIndex(step => step.id === selected)); const step = steps[index]!;
  const task = useTask(props.onError);
  const navigate = (index: number) => props.navigate(`/setup?step=${steps[index]!.id}`);
  const ready = props.data.accounts.some(view => view.account.enabled && props.data.runtimes.some(runtime => runtime.id === view.account.runtime && runtime.enabled) && view.statuses.some(status => status.deviceId === props.data.devices.currentDeviceId && status.auth === 'ready'));
  const next = () => task.run(async signal => {
    if (step.id === 'project') {
      const { projects } = await api('/hub/projects', ProjectsListSchema, 'GET', undefined, { signal, waitForHub: true });
      if (!projects.some(({ project }) => project.paths[props.data.devices.currentDeviceId] && (!project.allowedDevices || project.allowedDevices.includes(props.data.devices.currentDeviceId)))) throw new Error('Add a project on this device before continuing.');
    }
    navigate(index + 1);
  });
  return <section className="setup" aria-label="First-run setup">
    <ol className="setup-progress" aria-label="Setup progress">{steps.map((entry, number) => <li key={entry.id} aria-current={number === index ? 'step' : undefined}><span>{number + 1}</span>{entry.label}</li>)}</ol>
    <p className="setup-count">Step {index + 1} of 4</p><h1>{step.title}</h1><p className="intro">{step.explanation}</p>
    {step.id === 'jev' ? <JevConnection {...props}/> : step.id === 'account' ? <RuntimesPage {...props} embedded/> : step.id === 'project' ? <ProjectsPage {...props} embedded/> : <NewConversation {...props} embedded/>}
    <div className="setup-actions">
      {index > 0 && <button className="secondary" disabled={task.busy} onClick={() => navigate(index - 1)}>Back</button>}
      {step.id === 'jev' && !props.data.jev.saved && <button className="secondary" disabled={task.busy} onClick={() => navigate(1)}>Skip for now</button>}
      {index < 3 && <button disabled={task.busy || step.id === 'jev' && !props.data.jev.saved || step.id === 'account' && !ready} onClick={() => void next()}>Continue</button>}
    </div>
    {step.id === 'account' && !ready && <p className="muted small-text">Continue when an account is Ready on this device.</p>}
  </section>;
}
