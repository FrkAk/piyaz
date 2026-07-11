import type { Metadata } from "next";
import { Markdown } from "@/components/shared/Markdown";
import md from "@/content/legal/subprocessors.md";

export const metadata: Metadata = { title: "Sub-processors" };

/**
 * Public sub-processor list. Renders the tracked Markdown bundled as a
 * build-time module constant, so it serves with zero request-time fs and no auth.
 *
 * @returns Rendered sub-processor list and change-notification section.
 */
export default function SubprocessorsPage() {
  return <Markdown>{md}</Markdown>;
}
