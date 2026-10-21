import { EvidenceReferenceSchema, EvidenceReferencesViewSchema, type EvidenceReference } from './evidence-reference-schemas.js';
import type { Handoff } from './schemas.js';
export const storedPointer = (ref: string) =>
  /^(?:blobs\/[a-f0-9]{64}|(?:ledger|handoffs)\/[1-9]\d*)$/.test(ref);
export const filePointer = (ref: string) =>
  !/^(?:[a-z][a-z\d+.-]*:\/\/|mailto:|javascript:|data:)/i.test(ref) &&
  /^(?:\.?\.?\/|\/)?[^\n<>]+\.[A-Za-z][\w]{0,11}(?::[1-9]\d*(?::\d+)?|#L[1-9]\d*(?:-L?\d+)?)?$/.test(ref);
export function decodeReference(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}
type Node = { type: string; value?: string; url?: string; children?: Node[] };
/** Link bare absolute file paths in prose, leaving links and code untouched. */
export function remarkFilePaths() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || ['link', 'image', 'code', 'inlineCode'].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
          visit(child);
          return [child];
        }
        const parts: Node[] = [];
        let start = 0;
        for (const match of child.value.matchAll(
          /\/(?:[\w.@+~-]+\/)+[\w.@+~-]+\.[A-Za-z0-9]{1,12}(?::[1-9]\d*(?::\d+)?)?/g,
        )) {
          if (match.index && /[\w/:]/.test(child.value[match.index - 1]!)) continue;
          parts.push(
            { type: 'text', value: child.value.slice(start, match.index) },
            { type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] },
          );
          start = match.index + match[0].length;
        }
        return parts.length ? [...parts, { type: 'text', value: child.value.slice(start) }] : [child];
      });
    };
    visit(tree);
  };
}

export function evidenceReference(value: string): EvidenceReference {
  return EvidenceReferenceSchema.parse({ schema: 'evidence-reference-v1', value, kind: /^https?:\/\//i.test(value) ? 'url' : storedPointer(value) ? 'pointer' : filePointer(value) ? 'file' : 'text' });
}
export function conversationEvidenceReferences(handoffs: Handoff[]) {
  return EvidenceReferencesViewSchema.parse({ schema: 'evidence-references-view-v1', entries: handoffs.flatMap(row => [...row.evidence.map(entry => entry.ref), ...row.findings.map(entry => entry.pointer), ...row.changedFiles, ...(row.result ? [row.result.ref] : [])].map(value => ({ stretch: row.stretch, reference: evidenceReference(value) }))) });
}
/** The same deterministic affordance rules apply to Markdown in all clients. */
export function markdownEvidenceTarget(value: string, kind: 'link' | 'code' | 'image', open: boolean, imageOnly: boolean, className?: string): string | null {
  const image = /\.(png|jpe?g|gif|webp)$/iu.test(value);
  if (kind === 'link') return (open || imageOnly && image) && value && !/^(?:https?:|mailto:|#)/i.test(value) ? decodeReference(value) : null;
  if (kind === 'code') return (open || imageOnly && image) && !className && filePointer(value) ? value : null;
  return (open || imageOnly) && value && !/^https?:/i.test(value) ? decodeReference(value) : null;
}
export function relativeEvidenceReference(path: string, ref: string): string {
  if (ref.startsWith('/') || storedPointer(ref)) return ref;
  try { const url = new URL(ref, `https://project.invalid/${path}`); return `${decodeURIComponent(url.pathname.slice(1))}${url.hash}`; }
  catch { return ref; }
}
