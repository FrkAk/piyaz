import type { Metadata } from "next";
import { Markdown } from "@/components/shared/Markdown";
import md from "@/content/legal/impressum.md";

export const metadata: Metadata = { title: "Impressum" };

/**
 * Public Impressum page. Renders the tracked Markdown bundled as a
 * build-time module constant, so it serves with zero request-time fs.
 *
 * @returns Rendered Impressum document.
 */
export default function ImpressumPage() {
  return <Markdown>{md}</Markdown>;
}
