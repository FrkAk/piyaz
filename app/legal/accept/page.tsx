import { redirect } from "next/navigation";
import { getOutstandingConsent } from "@/lib/auth/consent";
import { requireSession } from "@/lib/auth/session";
import privacyMd from "@/content/legal/privacy.md";
import termsMd from "@/content/legal/terms.md";
import type { ReconsentDocumentType } from "@/lib/data/legal";
import { ReconsentGate, type ReconsentDoc } from "./_components/ReconsentGate";

export const dynamic = "force-dynamic";

/** Display metadata + bundled body per re-consent document. */
const DOCS: Record<ReconsentDocumentType, Omit<ReconsentDoc, "type">> = {
  terms: { title: "Terms of Service", href: "/terms", body: termsMd },
  privacy: { title: "Privacy Policy", href: "/privacy", body: privacyMd },
};

/**
 * Blocking re-acceptance interstitial. Every authenticated page redirects
 * here (via `requireLegalConsent`) while a personal legal document is
 * outstanding; this page itself is consent-exempt by construction and
 * bounces home once nothing is outstanding. Document bodies are bundled
 * Markdown module constants, so the page serves with zero request-time fs.
 *
 * @returns The gate UI listing each outstanding document.
 */
export default async function LegalAcceptPage() {
  const session = await requireSession();
  const outstanding = await getOutstandingConsent(session.user.id);
  if (outstanding.length === 0) redirect("/");

  const docs: ReconsentDoc[] = outstanding.map((type) => ({
    type,
    ...DOCS[type],
  }));
  return <ReconsentGate docs={docs} email={session.user.email} />;
}
