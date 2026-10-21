import type { AccountEditorFields, AccountEditorView, AccountEditorPreview } from '@jevellan/core/client';
type Endpoint = AccountEditorFields['endpoint'];
export function EndpointFields({ value, metadata, disabled, change, command }: { value: Endpoint; metadata: AccountEditorView['endpoint']; disabled: boolean; change(value: Endpoint): void; command(value: NonNullable<AccountEditorPreview['command']>): void }) {
  const copy = metadata.copy;
  const model = (index: number, patch: Partial<Endpoint['models'][number]>) => change({ ...value, models: value.models.map((row, i) => i === index ? { ...row, ...patch } : row) });
  return <>
    <p className="muted">{copy.help}</p>
    <label>{copy.baseUrl}<input type="url" disabled={disabled} required placeholder={copy.placeholder} value={value.baseUrl} onChange={event => change({ ...value, baseUrl: event.target.value })} /></label>
    <label>{copy.billing}<select disabled={disabled} value={value.billing} onChange={event => change({ ...value, billing: event.target.value as Endpoint['billing'] })}>{metadata.billing.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <fieldset className="endpoint-models"><legend>{copy.models}</legend>{value.models.map((row, index) => <div className="endpoint-model" key={index}>
      <label>{copy.modelId}<input disabled={disabled} required maxLength={metadata.limits.modelId} value={row.id} onChange={event => model(index, { id: event.target.value })} /></label>
      <label>{copy.label}<input disabled={disabled} required maxLength={metadata.limits.label} value={row.label} onChange={event => model(index, { label: event.target.value })} /></label>
      <fieldset><legend>{copy.efforts}</legend><div className="actions">{metadata.efforts.map(option => {
        const effort = option.value as Endpoint['models'][number]['efforts'][number];
        return <label className="check-label" key={effort}><input type="checkbox" disabled={disabled} checked={row.efforts.includes(effort)} onChange={event => model(index, { efforts: event.target.checked ? [...row.efforts, effort] : row.efforts.filter(item => item !== effort) })} />{option.label}</label>;
      })}</div></fieldset>
      <label>{copy.description}<textarea disabled={disabled} required maxLength={metadata.limits.description} value={row.description} onChange={event => model(index, { description: event.target.value })} /></label>
      {metadata.canRemove && <button type="button" disabled={disabled} className="text-button" onClick={() => command({ kind: 'remove-model', index })}>{copy.removeModel}</button>}
    </div>)}</fieldset>
    <button type="button" className="secondary small" disabled={disabled || !metadata.canAdd} onClick={() => command({ kind: 'add-model' })}>{copy.addModel}</button>
    <label>{copy.background}<input disabled={disabled} aria-describedby="endpoint-background-help" maxLength={metadata.limits.background} value={value.backgroundModel} placeholder={metadata.backgroundPlaceholder} onChange={event => change({ ...value, backgroundModel: event.target.value })} /></label><small id="endpoint-background-help">{copy.backgroundHelp}</small>
  </>;
}
