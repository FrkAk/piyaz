import type { Metadata } from "next";
import { Markdown } from "@/components/shared/Markdown";
import md from "@/content/legal/privacy.md";

export const metadata: Metadata = { title: "Privacy Policy" };

/**
 * Public privacy policy page. Renders the tracked Markdown bundled as
 * a build-time module constant, so it serves with zero request-time fs.
 *
 * @returns Rendered privacy policy document.
 */
export default function PrivacyPage() {
  return <Markdown>{md}</Markdown>;
}
