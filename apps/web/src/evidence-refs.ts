export const storedPointer = (ref: string) => /^(?:blobs\/[a-f0-9]{64}|(?:ledger|handoffs)\/[1-9]\d*)$/.test(ref);
export const filePointer = (ref: string) => !/^(?:[a-z][a-z\d+.-]*:\/\/|mailto:|javascript:|data:)/i.test(ref) && /^(?:\.?\.?\/|\/)?[^\n<>]+\.[A-Za-z][\w]{0,11}(?::[1-9]\d*(?::\d+)?|#L[1-9]\d*(?:-L?\d+)?)?$/.test(ref);
export function decodeReference(ref: string): string { try { return decodeURIComponent(ref); } catch { return ref; } }
type Node = { type: string; value?: string; url?: string; children?: Node[] };
/** Link bare absolute file paths in prose, leaving links and code untouched. */
export function remarkFilePaths() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || ['link', 'image', 'code', 'inlineCode'].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
        const parts: Node[] = []; let start = 0;
        for (const match of child.value.matchAll(/\/(?:[\w.@+~-]+\/)+[\w.@+~-]+\.[A-Za-z0-9]{1,12}(?::[1-9]\d*(?::\d+)?)?/g)) {
          if (match.index && /[\w/:]/.test(child.value[match.index - 1]!)) continue;
          parts.push({ type: 'text', value: child.value.slice(start, match.index) }, { type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] }); start = match.index + match[0].length;
        }
        return parts.length ? [...parts, { type: 'text', value: child.value.slice(start) }] : [child];
      });
    }; visit(tree);
  };
}
