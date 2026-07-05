import type { ReactNode } from "react";

/**
 * Public layout for the unauthenticated legal pages.
 *
 * Wraps the rendered Markdown in a centered, readable column so the raw
 * document has a comfortable measure on every viewport.
 *
 * @param props - Route children.
 * @returns Centered content column.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-[720px] px-6 py-12">{children}</main>;
}
