import { clientId } from './client-id.js';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  ConfigHistorySchema,
  ConfigPreviewSchema,
  ConfigRevisionSchema,
} from '@jevellan/core/client';
import { api } from './api.js';
import { PwaInstallCard } from './pwa.js';
import { SectionHeading, dateTime, useTask, type PageProps } from './components.js';

export function ConfigurationPage(props: PageProps) {
  const [history, setHistory] = useState<z.infer<typeof ConfigHistorySchema>['revisions']>([]);
  const [yaml, setYaml] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<z.infer<typeof ConfigPreviewSchema>>();
  const task = useTask(props.onError);
  useEffect(() => {
    void api('/hub/config/history', ConfigHistorySchema)
      .then((result) => setHistory(result.revisions.reverse()))
      .catch(props.onError);
  }, [props.data.config.revision, props.onError]);
  return (
    <>
      <SectionHeading title="Configuration">
        <div className="actions">
          <button
            className="secondary"
            onClick={() =>
              void task.run(async () => {
                if (yaml !== undefined) {
                  setYaml(undefined);
                  return;
                }
                const response = await fetch('/hub/config/export', { credentials: 'same-origin' });
                if (!response.ok) throw new Error('Configuration could not be loaded.');
                setYaml(await response.text());
              })
            }
          >
            {yaml === undefined ? 'View YAML' : 'Hide YAML'}
          </button>
          <a className="button-link secondary" href="/hub/config/export" download="apm.yml">
            Export
          </a>
          <button onClick={() => setImporting(true)}>Import</button>
        </div>
      </SectionHeading>
      <p className="intro">One configuration for every device. Each saved change creates a revision.</p>
      {yaml !== undefined && (
        <section className="card">
          <h2>Current YAML</h2>
          <pre>{yaml}</pre>
        </section>
      )}
      {importing && (
        <section className="card">
          <h2>Import configuration</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void task.run(async () =>
                setPreview(
                  await api('/hub/config/import-preview', ConfigPreviewSchema, 'POST', {
                    schema: 'config-import-v1',
                    yaml: source,
                  }),
                ),
              );
            }}
          >
            <label>
              YAML
              <textarea
                required
                rows={10}
                className="code-editor"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <div className="actions">
              <button disabled={task.busy}>Validate and show diff</button>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setImporting(false);
                  setPreview(undefined);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
          {preview && (
            <div className="import-preview">
              <h3>{preview.changedPaths.length ? 'Changes to apply' : 'No changes'}</h3>
              <ul>
                {preview.changedPaths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
              <div className="diff-columns">
                <div>
                  <h4>Current</h4>
                  <pre>{preview.before}</pre>
                </div>
                <div>
                  <h4>Imported</h4>
                  <pre>{preview.after}</pre>
                </div>
              </div>
              <button
                disabled={task.busy || !preview.changedPaths.length}
                onClick={() =>
                  void task.run(async (signal) => {
                    await api(
                      '/hub/config',
                      ConfigRevisionSchema,
                      'PUT',
                      {
                        schema: 'config-write-v1',
                        revision: preview.revision,
                        configuration: preview.configuration,
                        clientRequestId: `config_${clientId()}`,
                      },
                      { signal, waitForHub: true },
                    );
                    setPreview(undefined);
                    setImporting(false);
                    setYaml(undefined);
                    setSource('');
                    await props.reload(signal);
                    props.message('Configuration imported.');
                  })
                }
              >
                Apply import
              </button>
            </div>
          )}
        </section>
      )}
      <section className="card">
        <h2>Revisions</h2>
        <div className="revision-list">
          {history.map((revision) => (
            <div key={revision.revision}>
              <strong>Revision {revision.revision}</strong>
              <span>{dateTime(revision.at)}</span>
              <span className="muted">
                {props.data.devices.devices.find((device) => device.id === revision.changedBy.deviceId)
                  ?.name ?? revision.changedBy.deviceId}{' '}
                · {revision.changedBy.source === 'ui' ? 'Settings' : revision.changedBy.source}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
export { DecisionsPage } from './decisions-settings.js';
export function AboutPage(props: PageProps) {
  return (
    <>
      <SectionHeading title="About" />
      <PwaInstallCard />
      <section className="card">
        <h2>Jevellan</h2>
        <p>Autonomous development, coordinated.</p>
        <p className="muted">
          Version{' '}
          {
            props.data.devices.devices.find((device) => device.id === props.data.devices.currentDeviceId)
              ?.version
          }
        </p>
        <button className="secondary" onClick={() => props.navigate('/setup')}>
          Open setup guide
        </button>
        <h3>Update</h3>
        <code>jevellan update</code>
        <h3>Uninstall</h3>
        <code>jevellan uninstall</code>
      </section>
    </>
  );
}
