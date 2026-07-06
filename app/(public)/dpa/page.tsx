import type { Metadata } from "next";
import { Markdown } from "@/components/shared/Markdown";
import md from "@/content/legal/dpa.md";

export const metadata: Metadata = { title: "Data Processing Agreement" };

/**
 * Public data processing agreement page. Renders the tracked DRAFT Markdown
 * bundled as a build-time module constant, so it serves with zero request-time
 * fs and no auth.
 *
 * @returns Rendered data processing agreement document.
 */
export default function DpaPage() {
  return <Markdown>{md}</Markdown>;
}
