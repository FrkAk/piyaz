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
  terms: "beta-2026-07-11",
  privacy: "beta-2026-07-11",
  dpa: "beta-2026-07-11",
};
