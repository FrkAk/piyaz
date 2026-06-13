import type { BundleKind, BundleSectionId } from "@/lib/context/parts";
import type { TaskState } from "@/lib/data/task";
import type { TaskStatus } from "@/lib/types";

/**
 * Resolved bundle stage. Splits the derived `blocked` state on schema status
 * (a blocked draft keeps the working bundle; a blocked planned task gets the
 * agent bundle with the blocked treatment).
 */
export type BundleStage =
  | "draft"
  | "plannable"
  | "planned-blocked"
  | "ready"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";

/** Drawer-section table key: bundle kind, with `record` split per variant. */
export type BundleVariant =
  | Exclude<BundleKind, "record">
  | "record-done"
  | "record-cancelled";

/**
 * Resolve the visible bundle stage from the server-derived state plus the
 * schema status. `state` alone cannot derive the stage because
 * `deriveTaskState` returns `blocked` for both blocked drafts and blocked
 * planned tasks. When the task is missing from the slim payload (no derived
 * state) fall back to the schema status — `planned` maps to `ready` (the
 * next consumer is the implementer either way) and no chip is shown.
 *
 * @param status - Schema task status.
 * @param state - Server-derived task state, if the task appears in `allTasks`.
 * @returns Resolved bundle stage.
 */
export function resolveStage(
  status: TaskStatus,
  state: TaskState | undefined,
): BundleStage {
  if (state === undefined) {
    return status === "planned" ? "ready" : (status as BundleStage);
  }
  if (state === "blocked") {
    return status === "draft" ? "draft" : "planned-blocked";
  }
  return state;
}

/** Which bundle kind the next lifecycle consumer receives at each stage. */
export const BUNDLE_BY_STAGE: Record<BundleStage, BundleKind> = {
  draft: "working",
  plannable: "planning",
  "planned-blocked": "agent",
  ready: "agent",
  in_progress: "agent",
  in_review: "review",
  done: "record",
  cancelled: "record",
};

/** Header label / badge caption per stage. */
export const BUNDLE_LABEL_BY_STAGE: Record<BundleStage, string> = {
  draft: "Working Bundle",
  plannable: "Planning Bundle",
  "planned-blocked": "Agent Bundle",
  ready: "Agent Bundle",
  in_progress: "Agent Bundle",
  in_review: "Review Bundle",
  done: "Completion Record",
  cancelled: "Cancellation Record",
};

/**
 * Resolve the drawer-section table key for a stage — the record kind splits
 * into done/cancelled variants because their section lists differ.
 *
 * @param stage - Resolved bundle stage.
 * @returns Variant key into {@link SECTIONS_BY_BUNDLE}.
 */
export function variantOf(stage: BundleStage): BundleVariant {
  const kind = BUNDLE_BY_STAGE[stage];
  if (kind !== "record") return kind;
  return stage === "done" ? "record-done" : "record-cancelled";
}

/**
 * Drawer sections per bundle variant, in render order (render-if-nonempty).
 * The parity test in `tests/context/parity.test.ts` pins these lists against
 * the actual builder part order — change both together.
 */
export const SECTIONS_BY_BUNDLE: Record<
  BundleVariant,
  readonly BundleSectionId[]
> = {
  working: ["spec", "meta", "criteria", "decisions", "connected", "links"],
  planning: [
    "project",
    "spec",
    "criteria",
    "plan",
    "prerequisites",
    "built",
    "abandoned",
    "decisions",
    "links",
    "downstream",
  ],
  agent: [
    "blocked",
    "spec",
    "plan",
    "prerequisites",
    "built",
    "links",
    "downstream",
    "constraints",
    "criteria",
  ],
  review: [
    "project",
    "spec",
    "criteria",
    "plan",
    "execution",
    "decisions",
    "links",
    "prerequisites",
    "built",
    "downstream",
    "lens",
  ],
  "record-done": [
    "project",
    "spec",
    "criteria",
    "execution",
    "decisions",
    "links",
    "downstream",
  ],
  "record-cancelled": [
    "project",
    "spec",
    "execution",
    "decisions",
    "dependents",
    "links",
  ],
};

/**
 * Sections each builder emits unconditionally with fallback text (`None` /
 * `None recorded.`), per variant. The drawer renders these even when the
 * local data is empty so it mirrors the bundle markdown instead of hiding a
 * section the agent actually receives; everything else stays
 * render-if-nonempty. Change together with the builders in
 * `lib/context/_core/*`.
 */
export const ALWAYS_RENDERED_BY_BUNDLE: Record<
  BundleVariant,
  readonly BundleSectionId[]
> = {
  working: [],
  planning: ["spec", "criteria"],
  agent: ["spec", "criteria"],
  review: ["spec", "criteria", "plan", "execution"],
  "record-done": ["spec", "execution"],
  "record-cancelled": ["spec", "execution"],
};
