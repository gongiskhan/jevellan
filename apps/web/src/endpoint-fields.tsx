import { EffortSchema, type Account } from '@jevellan/core/client';
import { ENDPOINT as copy, EFFORT_LABELS } from './project-work-copy.js';
type Endpoint = NonNullable<Account['endpoint']>;
export function EndpointFields({ value, change }: { value: Endpoint; change(value: Endpoint): void }) {
  const model = (index: number, patch: Partial<Endpoint['models'][number]>) => change({ ...value, models: value.models.map((row, i) => i === index ? { ...row, ...patch } : row) });
  return <>
    <p className="muted">{copy.help}</p>
    <label>{copy.baseUrl}<input type="url" required placeholder={copy.placeholder} value={value.baseUrl} onChange={event => change({ ...value, baseUrl: event.target.value })} /></label>
    <label>{copy.billing}<select value={value.billing} onChange={event => change({ ...value, billing: event.target.value as Endpoint['billing'] })}>
      <option value="subscription">{copy.subscription}</option><option value="metered">{copy.metered}</option><option value="free">{copy.free}</option>
    </select></label>
    <fieldset className="endpoint-models"><legend>{copy.models}</legend>{value.models.map((row, index) => <div className="endpoint-model" key={index}>
      <label>{copy.modelId}<input required maxLength={200} value={row.id} onChange={event => model(index, { id: event.target.value })} /></label>
      <label>{copy.label}<input required maxLength={80} value={row.label} onChange={event => model(index, { label: event.target.value })} /></label>
      <fieldset><legend>{copy.efforts}</legend><div className="actions">{EffortSchema.options.map(effort => <label className="check-label" key={effort}><input type="checkbox" checked={row.efforts.includes(effort)} onChange={event => model(index, { efforts: event.target.checked ? [...row.efforts, effort] : row.efforts.filter(item => item !== effort) })} />{EFFORT_LABELS[effort]}</label>)}</div></fieldset>
      <label>{copy.description}<textarea required maxLength={600} value={row.description} onChange={event => model(index, { description: event.target.value })} /></label>
      {value.models.length > 1 && <button type="button" className="text-button" onClick={() => change({ ...value, models: value.models.filter((_, i) => i !== index) })}>{copy.removeModel}</button>}
    </div>)}</fieldset>
    <button type="button" className="secondary small" disabled={value.models.length >= 10} onClick={() => change({ ...value, models: [...value.models, { id: '', label: '', efforts: ['medium'], description: '' }] })}>{copy.addModel}</button>
    <label>{copy.background}<input aria-describedby="endpoint-background-help" maxLength={200} value={value.backgroundModel ?? ''} placeholder={value.models[0]?.id} onChange={event => change({ ...value, backgroundModel: event.target.value })} /></label><small id="endpoint-background-help">{copy.backgroundHelp}</small>
  </>;
}
