import type { LegalDocumentType } from "@/lib/types";

/**
 * Current version identifier per legal document, the single source of truth for
 * acceptance records and public page display.
 *
 * `terms` and `privacy` mirror the `Version:` line of `content/legal/terms.md`
 * and `content/legal/privacy.md`. `dpa` is a placeholder until the DPA text is
 * finalized in PYZ-298; downstream code reads `LEGAL_VERSIONS.dpa`
 * symbolically so the value can be bumped without touching call sites.
 */
export const LEGAL_VERSIONS: Record<LegalDocumentType, string> = {
  terms: "draft-2026-06-23",
  privacy: "draft-2026-06-23",
  dpa: "draft-unpublished",
};
