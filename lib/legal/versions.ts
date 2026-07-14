import type { LegalDocumentType } from "@/lib/types";

/**
 * Current version identifier per legal document, the single source of truth for
 * acceptance records and public page display.
 *
 * Each entry encodes the "Last updated" date of its document under
 * `content/legal/` (`terms.md`, `privacy.md`, `dpa.md`) as `beta-YYYY-MM-DD`;
 * update both together. Bumping a version re-offers the document for
 * acceptance; downstream code reads the values symbolically so a bump never
 * touches call sites.
 */
export const LEGAL_VERSIONS: Record<LegalDocumentType, string> = {
  terms: "beta-2026-07-12",
  privacy: "beta-2026-07-14",
  dpa: "beta-2026-07-12",
};

/** Human-facing name per legal document, for re-consent messaging. */
export const LEGAL_DOCUMENT_LABELS: Record<LegalDocumentType, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
  dpa: "Data Processing Agreement",
};

/**
 * Join outstanding document types into a human phrase naming exactly those
 * documents, so a single-document block never claims both were updated.
 *
 * @param outstanding - Document types lacking current-version acceptance.
 * @returns e.g. `"Terms of Service"` or `"Terms of Service and Privacy Policy"`.
 */
export function describeReconsentDocuments(
  outstanding: readonly string[],
): string {
  const labels = outstanding.map(
    (type) => LEGAL_DOCUMENT_LABELS[type as LegalDocumentType] ?? type,
  );
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
