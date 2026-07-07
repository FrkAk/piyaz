"use client";

import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { CodeBlock } from "@/components/shared/CodeBlock";

export const schema = {
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
  /** @param remarkPlugins - Extra remark plugins appended after GFM. */
  remarkPlugins?: Options["remarkPlugins"];
  /** @param components - Component overrides merged over the defaults. */
  components?: Components;
  /** @param sanitizeSchema - Replacement sanitize schema (defaults to built-in). */
  sanitizeSchema?: object;
}

/**
 * Shared markdown renderer with GFM support and XSS sanitization. Fenced
 * code blocks render through {@link CodeBlock} with lazy Shiki syntax
 * highlighting; inline code stays plain. Callers may append remark plugins,
 * override components, or replace the sanitize schema to add inline
 * affordances (e.g. note task-ref chips and `[[wiki]]` links).
 * @param props - Markdown configuration.
 * @returns A prose-styled div wrapping sanitized, GFM-enabled markdown.
 */
export function Markdown({
  children,
  className = "",
  remarkPlugins,
  components: extraComponents,
  sanitizeSchema,
}: MarkdownProps) {
  const wrapperClass = className ? `prose-spec ${className}` : "prose-spec";
  return (
    <div className={wrapperClass}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema ?? schema]]}
        components={{ ...components, ...extraComponents }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
