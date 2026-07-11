import type { Metadata } from "next";
import { Markdown } from "@/components/shared/Markdown";
import md from "@/content/legal/terms.md";

export const metadata: Metadata = { title: "Terms of Service" };

/**
 * Public terms of service page. Renders the tracked Markdown bundled
 * as a build-time module constant, so it serves with zero request-time fs.
 *
 * @returns Rendered terms of service document.
 */
export default function TermsPage() {
  return <Markdown>{md}</Markdown>;
}
