"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { CodeBlock } from "@/components/shared/CodeBlock";

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
  },
};

const EXTERNAL_URL = /^https?:\/\//i;

const components: Components = {
  a({ href, target, rel, children }) {
    const external = typeof href === "string" && EXTERNAL_URL.test(href);
    if (external) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    return (
      <a href={href} target={target} rel={rel}>
        {children}
      </a>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children }) {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    if (lang === undefined)
      return <code className={className}>{children}</code>;
    return <CodeBlock code={String(children).replace(/\n$/, "")} lang={lang} />;
  },
};

export interface MarkdownProps {
  /** @param children - Markdown source text to render. */
  children: string;
  /** @param className - Additional classes appended to the prose wrapper. */
  className?: string;
}

/**
 * Shared markdown renderer with GFM support and XSS sanitization. Fenced
 * code blocks render through {@link CodeBlock} with lazy Shiki syntax
 * highlighting; inline code stays plain.
 * @param props - Markdown configuration.
 * @returns A prose-styled div wrapping sanitized, GFM-enabled markdown.
 */
export function Markdown({ children, className = "" }: MarkdownProps) {
  const wrapperClass = className ? `prose-spec ${className}` : "prose-spec";
  return (
    <div className={wrapperClass}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
