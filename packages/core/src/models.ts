import { randomBytes } from 'node:crypto';
import { EffortSchema, IdSchema, ModelOptionSchema, type Effort, type ModelOption } from './schemas.js';

export function newId(prefix: string, now = Date.now()): string {
  IdSchema.parse(prefix);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let encoded = '';
  for (let i = 0; i < 26; i++) { encoded = alphabet[Number(value & 31n)]! + encoded; value >>= 5n; }
  return `${prefix}_${encoded}`;
}
export function mapEffort(requested: Effort, supported: Effort[]): Effort {
  const order = EffortSchema.options;
  if (!supported.length) throw new Error('This model has no supported effort levels.');
  const available = [...new Set(supported.map((effort) => EffortSchema.parse(effort)))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const target = order.indexOf(EffortSchema.parse(requested));
  return available.find((effort) => order.indexOf(effort) >= target) ?? available.at(-1)!;
}
export type OfferedModel = { id: string; label: string; efforts: Effort[] };
export function reconcileMenu(menu: ModelOption[], runtime: string, offered: OfferedModel[]): ModelOption[] {
  return menu.map((raw) => {
    const entry = ModelOptionSchema.parse(raw);
    if (entry.runtime !== runtime) return entry;
    // Runtime ordering is authoritative for its current default/latest model.
    const model = entry.model === 'discover-latest-gpt' ? offered.find((candidate) => /^gpt-/i.test(candidate.id)) : offered.find((candidate) => candidate.id === entry.model);
    if (!model || !model.efforts.length) return { ...entry, enabled: false, unavailableReason: 'Not offered by this runtime right now.' };
    const { unavailableReason, ...current } = entry;
    return ModelOptionSchema.parse({ ...current, model: model.id, efforts: model.efforts, enabled: unavailableReason === 'Model discovery has not run.' ? true : entry.enabled });
  });
}
