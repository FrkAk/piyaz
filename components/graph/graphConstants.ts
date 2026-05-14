import type { EdgeType } from "@/lib/types";
import type { SimulationLinkDatum } from "d3-force";

// ---------------------------------------------------------------------------
// Graph node / link types
// ---------------------------------------------------------------------------

/** A node in the force-directed graph with d3-force positional fields. */
export interface GraphNode {
  id: string;
  title: string;
  taskRef: string;
  status: string;
  tags: string[];
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;

  // Animation fields (managed per-tick)
  /** Entrance progress 0->1. */
  _enterT: number;
  /** Dim progress 0=normal, 1=fully dimmed. */
  _dimT: number;
  /** Selection glow progress 0->1. */
  _selectGlow: number;
  /** Hover/focus scale progress 0->1 (driven by hover or selection). */
  _hoverT: number;
}

/** A link between two graph nodes. */
export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  type: EdgeType;
}

// ---------------------------------------------------------------------------
// Visual constants
// ---------------------------------------------------------------------------

/** Default node radius (used as fallback). */
export const NODE_RADIUS_DEFAULT = 14;

export const EDGE_COLOR: Record<EdgeType, string> = {
  depends_on: "#55b3ff",
  relates_to: "#a78bfa",
};

export const RELATES_DASH: number[] = [4, 6];
export const RELATES_OPACITY = 0.6;

export const ACCENT = "#818cf8";

export const ZOOM_FACTOR = 1.2;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

// ---------------------------------------------------------------------------
// Node sizing by connectivity
// ---------------------------------------------------------------------------

/**
 * Compute node radius based on edge count.
 * @param nodeId - Node ID.
 * @param linkCounts - Map of node ID to edge count.
 * @returns Pixel radius for the node.
 */
export function getNodeSize(nodeId: string, linkCounts: Map<string, number>): number {
  const count = linkCounts.get(nodeId) ?? 0;
  if (count >= 7) return 22;
  if (count >= 4) return 18;
  return 14;
}

/**
 * Build a map of node ID -> edge count from links array.
 * @param links - Array of graph links.
 * @returns Map of node ID to number of connections.
 */
export function buildLinkCounts(links: GraphLink[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of links) {
    const srcId = typeof l.source === "string" ? l.source : l.source.id;
    const tgtId = typeof l.target === "string" ? l.target : l.target.id;
    counts.set(srcId, (counts.get(srcId) ?? 0) + 1);
    counts.set(tgtId, (counts.get(tgtId) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Theme colors
// ---------------------------------------------------------------------------

export interface ThemeColors {
  labelText: string;
  labelDimmed: string;
  hoverGlow: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  taskBorder: string;
  statusDraft: string;
  statusPlanned: string;
  statusInProgress: string;
  statusInReview: string;
  statusDone: string;
  statusCancelled: string;
  surface: string;
  /** True when rendering against the light theme. Drives node halo/fill
   *  alpha boosts so colored pixels stay visible against a near-white
   *  surface (the dark-mode tuning relies on additive contrast). */
  isLight: boolean;
  /** Alpha at the centre of the ambient radial halo behind each node. */
  haloAlpha: number;
  /** Alpha at the centre of the radial gradient that fills the node body. */
  fillInnerAlpha: number;
  /** Alpha at the outer edge of the node fill gradient. */
  fillOuterAlpha: number;
}

export const DARK_THEME: ThemeColors = {
  labelText: "#f9f9f9",
  labelDimmed: "rgba(249,249,249,0.2)",
  hoverGlow: "rgba(249,249,249,0.4)",
  tooltipBg: "rgba(7,8,10,0.95)",
  tooltipBorder: "rgba(255,255,255,0.10)",
  tooltipText: "#f9f9f9",
  taskBorder: "#07080a",
  // Brighter on dark — the previous #9ca3af leaned too neutral and the
  // dashed draft ring + reduced fill made the nodes vanish into the
  // canvas surface. This still reads as "muted / unspecced" against the
  // filled status colours.
  statusDraft: "#b9c1cb",
  statusPlanned: "#55b3ff",
  statusInProgress: "#ffbc33",
  statusInReview: "#a78bfa",
  statusDone: "#5fc992",
  statusCancelled: "#e57373",
  surface: "rgba(7,8,10,0.85)",
  isLight: false,
  haloAlpha: 0.12,
  fillInnerAlpha: 0.6,
  fillOuterAlpha: 0.05,
};

export const LIGHT_THEME: ThemeColors = {
  labelText: "#1a1a1a",
  labelDimmed: "rgba(26,26,26,0.2)",
  hoverGlow: "rgba(26,26,26,0.2)",
  tooltipBg: "rgba(255,255,255,0.97)",
  tooltipBorder: "rgba(0,0,0,0.10)",
  tooltipText: "#1a1a1a",
  taskBorder: "#f0f1f3",
  statusDraft: "#6b7280",
  statusPlanned: "#3b82f6",
  statusInProgress: "#d97706",
  statusInReview: "#7c3aed",
  statusDone: "#059669",
  statusCancelled: "#c25454",
  surface: "rgba(255,255,255,0.85)",
  isLight: true,
  haloAlpha: 0.22,
  fillInnerAlpha: 0.85,
  fillOuterAlpha: 0.20,
};

/**
 * Read canvas theme colors from CSS custom properties at runtime.
 * Falls back to static DARK_THEME/LIGHT_THEME during SSR or if reading fails.
 * @returns ThemeColors matching the current CSS theme.
 */
export function getCanvasTheme(): ThemeColors {
  if (typeof document === "undefined") return DARK_THEME;
  const isLight = document.documentElement.classList.contains("light");
  const base = isLight ? LIGHT_THEME : DARK_THEME;
  try {
    const s = getComputedStyle(document.documentElement);
    const read = (prop: string) => s.getPropertyValue(prop).trim();
    const surface = read("--color-surface");
    const textPrimary = read("--color-text-primary");
    if (!surface || !textPrimary) return base;
    return {
      ...base,
      labelText: textPrimary,
      labelDimmed: isLight ? "rgba(26,26,26,0.2)" : "rgba(249,249,249,0.2)",
      surface: isLight ? "rgba(255,255,255,0.85)" : "rgba(7,8,10,0.85)",
      tooltipText: textPrimary,
      statusDraft: read("--color-todo") || base.statusDraft,
      statusInReview: read("--color-glyph-review") || base.statusInReview,
      statusDone: read("--color-done") || base.statusDone,
      statusCancelled: read("--color-cancelled") || base.statusCancelled,
    };
  } catch {
    return base;
  }
}

/**
 * Map a lifecycle stage (schema status, or one of the derived sub-stages
 * `plannable` / `ready`) to a theme color.
 *
 * Palette is split along execution intent:
 *   - `plannable` → planned blue (still in the planning arc).
 *   - `ready`     → in-progress orange (staged for execution; the next
 *                   transition flips this task to `in_progress`).
 * The canvas distinguishes shape from colour: `plannable` and `ready` both
 * draw hollow, but their ring colour signals which arc the task is in.
 *
 * @param stage - Lifecycle stage string (status or `plannable` / `ready`).
 * @param t - Theme colors.
 * @returns Hex color string for the stage.
 */
export function statusColor(stage: string, t: ThemeColors): string {
  switch (stage) {
    case "done": return t.statusDone;
    case "planned":
    case "plannable":
      return t.statusPlanned;
    case "ready":
    case "in_progress":
      return t.statusInProgress;
    case "in_review": return t.statusInReview;
    case "cancelled": return t.statusCancelled;
    default: return t.statusDraft;
  }
}

/**
 * Parse hex color to RGB.
 * @param hex - Hex color string (e.g. "#6366f1").
 * @returns [r, g, b] tuple.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Ease-out cubic: decelerating to zero.
 * @param t - Progress value between 0 and 1.
 * @returns Eased value between 0 and 1.
 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// Adaptive performance tier
// ---------------------------------------------------------------------------

/** Performance tier — tunes simulation cost and visual richness. */
export type GraphTier = "high" | "mid" | "low";

/** Per-tier knobs read by the simulation hook and the canvas renderer. */
export interface GraphTierConfig {
  /** Pre-tick iteration count for synchronous layout (no-explosion mounts). */
  preTickN: number;
  /** d3-force alphaDecay — higher = faster cooldown. */
  alphaDecay: number;
  /** d3-force link iterations per tick. */
  linkIterations: number;
  /** Cap for `window.devicePixelRatio` when sizing the canvas backing store. */
  maxDpr: number;
  /** Whether to draw the animated flow dots along `depends_on` edges. */
  flowDots: boolean;
  /** Whether to draw the radial ambient halo behind each node. */
  halo: boolean;
}

const TIER_CONFIG: Record<GraphTier, GraphTierConfig> = {
  high: { preTickN: 320, alphaDecay: 0.022, linkIterations: 3, maxDpr: 2, flowDots: true,  halo: true  },
  mid:  { preTickN: 220, alphaDecay: 0.040, linkIterations: 2, maxDpr: 2, flowDots: true,  halo: true  },
  low:  { preTickN: 120, alphaDecay: 0.060, linkIterations: 1, maxDpr: 1, flowDots: false, halo: false },
};

/**
 * Detect the device performance tier from `navigator` heuristics.
 * Falls back to `mid` on the server or when the heuristics are missing.
 * @returns Tier string suitable for indexing `TIER_CONFIG`.
 */
export function getDeviceTier(): GraphTier {
  if (typeof navigator === "undefined") return "mid";
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores >= 8 && memory >= 8) return "high";
  if (cores >= 4 && memory >= 2) return "mid";
  return "low";
}

/**
 * Resolve the config for a tier.
 * @param tier - Performance tier.
 * @returns Tunables for the simulation and renderer.
 */
export function getTierConfig(tier: GraphTier): GraphTierConfig {
  return TIER_CONFIG[tier];
}
