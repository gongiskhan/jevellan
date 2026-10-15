import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { decodeReference, filePointer, remarkFilePaths } from './evidence-refs.js';
import { Children, isValidElement, type ReactNode } from 'react';
import { ShellCommand } from './owner-commands.js';
function ShellPre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && /^language-(?:bash|sh|zsh|shell|console)$/u.test(child.props.className ?? '') && typeof child.props.children === 'string')
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
            (onOpen || onOpenImage && /\.(png|jpe?g|gif|webp)$/iu.test(href ?? '')) && href && !/^(?:https?:|mailto:|#)/i.test(href) ? (
              <button className="text-button evidence-link" onClick={() => (onOpen ?? onOpenImage)?.(decodeReference(href))}>
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
            (onOpen || onOpenImage && typeof children === 'string' && /\.(png|jpe?g|gif|webp)$/iu.test(children)) && !className && typeof children === 'string' && filePointer(children) ? (
              <button className="text-button evidence-link" onClick={() => (onOpen ?? onOpenImage)?.(children)}>
                <code>{children}</code>
              </button>
            ) : (
              <code className={className}>{children}</code>
            ),
          img: ({ src, alt }) =>
            (onOpen || onOpenImage) && src && !/^https?:/i.test(src) ? (
              <button className="text-button evidence-link" onClick={() => (onOpen ?? onOpenImage)?.(decodeReference(src))}>
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
