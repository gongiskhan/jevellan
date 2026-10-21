import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { filePointer, remarkFilePaths, markdownEvidenceTarget, isOwnerShellFence } from '@jevellan/core/client';
import { Children, isValidElement, type ReactNode } from 'react';
import { ShellCommand } from './owner-commands.js';
function ShellPre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && isOwnerShellFence(child.props.className) && typeof child.props.children === 'string')
    return <ShellCommand command={child.props.children}><pre>{children}</pre></ShellCommand>;
  return <pre>{children}</pre>;
}
export default function Markdown({ children, onOpen, onOpenImage }: { children: string; onOpen?(ref: string): void; onOpenImage?(ref: string): void }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={onOpen ? [remarkGfm, remarkFilePaths] : [remarkGfm]}
        urlTransform={(value) => (onOpen && filePointer(value) ? value : defaultUrlTransform(value))}
        skipHtml
        components={{
          pre: ShellPre,
          a: ({ href, children }) =>
            markdownEvidenceTarget(href ?? '', 'link', !!onOpen, !!onOpenImage) !== null ? (
              <button className="text-button evidence-link" onClick={() => (onOpen ?? onOpenImage)?.(markdownEvidenceTarget(href ?? '', 'link', !!onOpen, !!onOpenImage)!)}>
                {children}
              </button>
            ) : (
              <a
                href={href}
                target={href?.startsWith('http') ? '_blank' : undefined}
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ),
          code: ({ children, className }) =>
            typeof children === 'string' && markdownEvidenceTarget(children, 'code', !!onOpen, !!onOpenImage, className) !== null ? (
              <button className="text-button evidence-link" onClick={() => (onOpen ?? onOpenImage)?.(children)}>
                <code>{children}</code>
              </button>
            ) : (
              <code className={className}>{children}</code>
            ),
          img: ({ src, alt }) =>
            markdownEvidenceTarget(src ?? '', 'image', !!onOpen, !!onOpenImage) !== null ? (
              <button className="text-button evidence-link" onClick={() => (onOpen ?? onOpenImage)?.(markdownEvidenceTarget(src ?? '', 'image', !!onOpen, !!onOpenImage)!)}>
                {alt || src}
              </button>
            ) : (
              <img src={src} alt={alt} />
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
