/**
 * Structured bundle parts shared by the server context builders, the
 * per-task context route, and the workspace bundle preview. Pure types and
 * helpers only — this module is imported from client components, so it must
 * never import "server-only" or any data layer.
 */

/**
 * The five bundle kinds the route serves via `?bundle=<kind>`. The array is
 * the single source the {@link BundleKind} union derives from, so route
 * validation and the type cannot drift.
 */
export const BUNDLE_KINDS = [
  "working",
  "planning",
  "agent",
  "review",
  "record",
] as const;

/** One of the five bundle kinds, derived from {@link BUNDLE_KINDS}. */
export type BundleKind = (typeof BUNDLE_KINDS)[number];

/**
 * Effective dependency hops included in every closure-backed bundle.
 * Shared by the server's recursive-CTE walks and the client's mirrored
 * walk in `lib/ui/effective-prereqs.ts` so the preview cannot drift from
 * the bundle contents.
 */
export const CLOSURE_DEPTH = 2;

/** Drawer-facing section identifiers shared by builders and the preview UI. */
export type BundleSectionId =
  | "spec"
  | "meta"
  | "criteria"
  | "plan"
  | "prerequisites"
  | "built"
  | "abandoned"
  | "decisions"
  | "constraints"
  | "connected"
  | "links"
  | "downstream"
  | "dependents"
  | "execution"
  | "project"
  | "blocked"
  | "lens";

/** Part identifiers: drawer sections plus bundle-only chrome. */
export type BundlePartId =
  | BundleSectionId
  | "notice"
  | "header"
  | "nudge"
  | "status-note";

/** One structured section of a context bundle. */
export type BundlePart = {
  /** Stable identifier mapping the part onto a drawer section (or chrome). */
  id: BundlePartId;
  /** Rendered markdown heading text, or null for chrome parts. */
  heading: string | null;
  /** Exact markdown chunk; the bundle string is the deterministic join. */
  markdown: string;
};

/**
 * Join bundle parts into the canonical bundle string.
 *
 * Byte-contract: every builder's parts are the exact strings it previously
 * pushed into its internal `parts: string[]`, so this join reproduces the
 * MCP output byte-for-byte.
 *
 * @param parts - Ordered bundle parts.
 * @returns The joined markdown bundle.
 */
export function joinParts(parts: BundlePart[]): string {
  return parts.map((p) => p.markdown).join("\n\n");
}
