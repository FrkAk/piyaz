import type { LegalDocumentType } from "@/lib/types";

/**
 * Current version identifier per legal document, the single source of truth for
 * acceptance records and public page display.
 *
 * Each entry mirrors the `Version:` line of its document under `content/legal/`
 * (`terms.md`, `privacy.md`, `dpa.md`). Bumping a version re-offers the
 * document for acceptance; downstream code reads the values symbolically so a
 * bump never touches call sites.
 */
export const LEGAL_VERSIONS: Record<LegalDocumentType, string> = {
  terms: "draft-2026-07-10",
  privacy: "draft-2026-07-10",
  dpa: "draft-2026-07-10",
};
