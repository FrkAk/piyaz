"use client";

import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { getTheme, subscribeTheme } from "@/lib/theme";
import { type HighlightLine, highlight } from "@/lib/ui/highlighter";

interface CodeBlockProps {
  /** @param code - Raw code text. */
  code: string;
  /** @param lang - Fence info-string language, if any. */
  lang?: string;
}

/**
 * Fenced code block with lazy, theme-aware Shiki highlighting. Highlights
 * client-side into React spans (no raw HTML); renders plain monospace
 * while the grammar loads and for unknown or missing languages. Re-runs on
 * theme toggle. Inherits the surrounding `prose-spec pre` box styling.
 *
 * @param props - Code text and language.
 * @returns The highlighted (or plain) code block.
 */
export function CodeBlock({ code, lang }: CodeBlockProps) {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const [highlighted, setHighlighted] = useState<{
    key: string;
    lines: HighlightLine[];
  } | null>(null);
  const key = `${theme}:${lang ?? ""}:${code}`;

  useEffect(() => {
    if (lang === undefined || lang === "") return;
    let active = true;
    highlight(code, lang, theme).then((result) => {
      if (active && result !== null) setHighlighted({ key, lines: result });
    });
    return () => {
      active = false;
    };
  }, [code, lang, theme, key]);

  const lines = highlighted?.key === key ? highlighted.lines : null;
  if (lines === null) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <pre>
      <code>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable line order
          <Fragment key={i}>
            {i > 0 && "\n"}
            {line.tokens.map((token, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable token order
              <span key={j} style={{ color: token.color }}>
                {token.content}
              </span>
            ))}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

export default CodeBlock;
