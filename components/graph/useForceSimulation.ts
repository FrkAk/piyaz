import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  forceRadial,
} from "d3-force";
import type { Simulation } from "d3-force";
import { quadtree } from "d3-quadtree";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type {
  NoteGraphSlim,
  TaskGraphEdge,
  TaskGraphSlim,
} from "@/lib/data/views";
import type {
  GraphNode,
  GraphLink,
  GraphTierConfig,
  NoteLinkType,
} from "./graphConstants";
import {
  getNodeSize,
  buildLinkCounts,
  getDeviceTier,
  getTierConfig,
  isNoteLinkType,
} from "./graphConstants";

/** Slim task record used for graph rendering — heavy fields are not needed. */
type GraphTask = TaskGraphSlim;

/** Direction-agnostic note edge (note-note or note-task), pre-flattened by
 *  the consumer from the slim payload's two link arrays. `type` carries the
 *  relation so the renderer styles each stratum apart. */
export interface NoteEdge {
  sourceId: string;
  targetId: string;
  type: NoteLinkType;
}


// ---------------------------------------------------------------------------
// Link distance per edge type
// ---------------------------------------------------------------------------

/** Velocity damping per tick. Higher = settles faster but feels rigid. */
const VELOCITY_DECAY = 0.3;

/** Tick budget for the synchronous mini-relax used by cached focus-path
 *  mounts and reheats while a selection is live. Tuned so the integration is
 *  invisible (no perceived motion) while neighbours absorb the disturbance. */
const MINI_RELAX_TICKS = 30;

/**
 * Force parameters derived from graph complexity. Larger N + denser edges
 * need more spread per node, otherwise the simulation packs everything into
 * a single hairball at the canvas centre. The formulae are tuned so a 20-
 * node project stays cosy and a 300-node project breathes — every knob
 * scales smoothly without regime-switching.
 */
interface ForceConfig {
  linkDistDepends: number;
  linkDistRelates: number;
  chargeStrength: number;
  chargeDistanceMax: number;
  collidePadding: number;
  centerStrength: number;
}

/**
 * Derive a force-config for a graph of `N` nodes and `E` edges. Pure
 * function — call it once per topology rebuild.
 *
 * @param N - Node count.
 * @param E - Edge count.
 * @returns Tuned force parameters for `makeSim`.
 */
function deriveForceConfig(N: number, E: number): ForceConfig {
  // 1.0 for tiny graphs, ~2.27 for 187, ~3.0 at 1000 nodes.
  const complexity = Math.log10(Math.max(N, 10));
  // Average edges per node (raw, not /2). Bumps spread for tangled graphs.
  const density = E / Math.max(N, 1);
  return {
    linkDistDepends: 110 + 50 * complexity + 6 * density,
    linkDistRelates: 90 + 40 * complexity + 4 * density,
    chargeStrength: Math.max(-1500, -180 - N * 5 - density * 50),
    chargeDistanceMax: 600 + complexity * 80,
    collidePadding: Math.min(60, 22 + Math.sqrt(N) * 1.4),
    centerStrength: Math.max(0.025, 0.075 - complexity * 0.013),
  };
}

/**
 * Multiplier that stretches simulation time for larger graphs. Crowded
 * projects need more ticks for the decongestion + radial scaffold to
 * untangle the central knot; a 50-node graph is fine at the tier defaults.
 *
 * Tuned so:
 * - N ≤ 50: scale = 1 (no change, snappy).
 * - N = 100: scale ≈ 1.41 (~40% more time).
 * - N = 200: scale ≈ 2.0 (~2× more time).
 * - N ≥ 400: scale = 2.5 (clamped, never blocks the UI for too long).
 *
 * @param N - Node count.
 * @returns Multiplier for `tier.preTickN` and divisor for `tier.alphaDecay`.
 */
function deriveSettleScale(N: number): number {
  return Math.min(2.5, Math.max(1, Math.sqrt(N / 50)));
}

// ---------------------------------------------------------------------------
// Module-level position cache
// ---------------------------------------------------------------------------

/**
 * Position cache keyed by `projectId → nodeId → {x, y}`. Lives outside React
 * so the layout survives every component remount (Structure ↔ Graph view
 * swap, breakpoint flip, etc.) and the simulation never has to re-explode
 * from a ring on a return visit.
 */
const positionCache = new Map<string, Map<string, { x: number; y: number }>>();

/**
 * Read or create the per-project entry in the position cache.
 * @param projectId - Project identifier (cache key).
 * @returns The mutable inner map for that project.
 */
function getProjectCache(
  projectId: string,
): Map<string, { x: number; y: number }> {
  let m = positionCache.get(projectId);
  if (!m) {
    m = new Map();
    positionCache.set(projectId, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Simulation state machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle phase of the simulation. The consumer drives camera behaviour off
 * this — `settled` triggers a fit-to-graph, `focused` triggers a centre-on-
 * node, and `settling` is "leave the camera alone, the layout is still
 * moving".
 */
export type SimState = "cold" | "settling" | "settled" | "focused";

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

interface BuildResult {
  nodes: GraphNode[];
  links: GraphLink[];
}

/**
 * Build GraphNode + GraphLink arrays from tasks, notes, and their edges.
 * Nodes whose id appears in `saved` reuse the saved x/y (and skip the
 * entrance fade) so a remount with cached positions paints in the same
 * place. Tasks and notes share one spawn spiral so mixed graphs explode
 * from the same distribution as task-only ones.
 *
 * @param taskList - Task records.
 * @param edges - Slim edge records.
 * @param noteList - Slim note records.
 * @param noteEdges - Flattened note-note and note-task edges.
 * @param cx - Initial-ring centre X (used only for uncached nodes).
 * @param cy - Initial-ring centre Y.
 * @param saved - Per-project position cache.
 * @returns Nodes and links ready for `forceSimulation`.
 */
function buildGraph(
  taskList: GraphTask[],
  edges: TaskGraphEdge[],
  noteList: NoteGraphSlim[],
  noteEdges: NoteEdge[],
  cx: number,
  cy: number,
  saved: Map<string, { x: number; y: number }>,
): BuildResult {
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  const total = taskList.length + noteList.length;
  // Sunflower spiral spacing — grows with project complexity so a 200-node
  // graph spawns closer to its equilibrium spread instead of having to
  // expand from a tight ring. Cuts settle time dramatically for large N.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spacing = 30 + 25 * Math.log10(Math.max(total, 10));

  const spawn = (i: number) => {
    const r = Math.sqrt(i + 0.5) * spacing;
    const angle = i * golden;
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  };

  for (let i = 0; i < taskList.length; i++) {
    const t = taskList[i];
    const s = saved.get(t.id);
    const p = s ?? spawn(i);
    nodes.push({
      id: t.id,
      title: t.title,
      taskRef: t.taskRef,
      status: t.status,
      kind: "task",
      fed: false,
      tags: t.tags ?? [],
      x: p.x,
      y: p.y,
      _enterT: s ? 1 : 0,
      _dimT: 0,
      _selectGlow: 0,
      _hoverT: 0,
    });
    ids.add(t.id);
  }

  for (let i = 0; i < noteList.length; i++) {
    const n = noteList[i];
    const s = saved.get(n.id);
    const p = s ?? spawn(taskList.length + i);
    nodes.push({
      id: n.id,
      title: n.title,
      taskRef: n.noteRef,
      status: "note",
      kind: "note",
      noteType: n.type,
      fed: n.fed,
      tags: [],
      x: p.x,
      y: p.y,
      _enterT: s ? 1 : 0,
      _dimT: 0,
      _selectGlow: 0,
      _hoverT: 0,
    });
    ids.add(n.id);
  }

  const links: GraphLink[] = [];
  for (const e of edges) {
    if (ids.has(e.sourceTaskId) && ids.has(e.targetTaskId)) {
      links.push({
        source: e.sourceTaskId,
        target: e.targetTaskId,
        type: e.edgeType,
      });
    }
  }
  for (const e of noteEdges) {
    if (ids.has(e.sourceId) && ids.has(e.targetId)) {
      links.push({ source: e.sourceId, target: e.targetId, type: e.type });
    }
  }

  return { nodes, links };
}

/**
 * Construct a fresh d3-force simulation over the given nodes and links.
 * Uses the `forceX`/`forceY` disjoint-graph pattern (instead of `forceCenter`)
 * so disconnected components are each pulled gently toward the centre.
 *
 * @param nodes - Nodes to drive.
 * @param links - Links to constrain by distance.
 * @param w - Canvas width.
 * @param h - Canvas height.
 * @param tier - Adaptive performance config.
 * @returns A configured but un-restarted simulation.
 */
/** Edge count at and above which a node is treated as a hub. Drives the
 *  radial scaffold and per-node charge bonus. Below this, the node is
 *  governed by the standard link / charge / collide trio. */
const HUB_THRESHOLD = 4;

/**
 * Custom force that detects locally-crowded nodes and nudges each one
 * away from the centroid of its neighbours — i.e. toward the emptier side
 * of the local neighbourhood. Acts only when at least `threshold + 1`
 * neighbours sit inside `searchRadius`, so stable clusters (a hub with its
 * leaves) aren't torn apart — only true knots get the kick.
 *
 * The push strength follows an `alpha · (1 − alpha) · 4` parabola so the
 * force is dormant during the cold-start explosion (high alpha = chaos
 * already), peaks mid-settle (when knots stabilise into local minima), and
 * fades to zero as the simulation cools. Cost is O(n log n) per tick via
 * a freshly-built quadtree — trivial for any realistic project size.
 *
 * @param searchRadius - World-space radius for the neighbour query.
 * @param threshold - Strict neighbour-count floor; a node only gets pushed
 *   when more than this many other nodes sit inside `searchRadius`.
 * @returns A d3-force compatible force function.
 */
function forceDecongest(searchRadius: number, threshold: number) {
  let nodesArr: GraphNode[] = [];
  let tickIdx = 0;
  const sr2 = searchRadius * searchRadius;

  function force(alpha: number) {
    // Stride every other tick — the layout knot evolves slowly compared to a
    // 60 Hz tick so a half-rate decongest is visually indistinguishable while
    // halving the per-tick quadtree rebuild cost.
    tickIdx = (tickIdx + 1) | 0;
    if (tickIdx % 2 !== 0) return;
    if (nodesArr.length === 0) return;
    // Skip during the initial chaos (alpha > 0.7) — every node is moving
    // anyway, and the centroid heuristic produces noisy pushes — and during
    // the near-settled phase (alpha < 0.05) where any nudge re-introduces
    // jitter just before equilibrium.
    if (alpha > 0.7 || alpha < 0.05) return;
    const alphaFactor = Math.max(0, alpha * (1 - alpha) * 4);
    if (alphaFactor < 0.02) return;

    const qt = quadtree<GraphNode>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(nodesArr);

    for (const n of nodesArr) {
      if (n.fx != null && n.fy != null) continue;
      const nx = n.x ?? 0;
      const ny = n.y ?? 0;
      let cx = 0;
      let cy = 0;
      let count = 0;
      qt.visit((node, x0, y0, x1, y1) => {
        type Leaf = { data: GraphNode; next?: Leaf };
        let leaf = node as unknown as Leaf | undefined;
        if (!("length" in node)) {
          while (leaf) {
            const d = leaf.data;
            if (d !== n && d?.x != null && d.y != null) {
              const dx = d.x - nx;
              const dy = d.y - ny;
              if (dx * dx + dy * dy < sr2) {
                cx += d.x;
                cy += d.y;
                count++;
              }
            }
            leaf = leaf.next;
          }
        }
        return (
          x0 > nx + searchRadius ||
          x1 < nx - searchRadius ||
          y0 > ny + searchRadius ||
          y1 < ny - searchRadius
        );
      });

      if (count <= threshold) continue;

      // Push direction = away from neighbours' centroid. Magnitude scales
      // with crowd intensity, capped so an outlier surrounded by fifteen
      // nodes doesn't get hurled across the canvas in a single tick.
      const ddx = nx - cx / count;
      const ddy = ny - cy / count;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      const intensity = Math.min(5, count - threshold);
      const push = alphaFactor * 0.6 * intensity;
      if (n.vx != null) n.vx += (ddx / dist) * push;
      if (n.vy != null) n.vy += (ddy / dist) * push;
    }
  }

  force.initialize = (n: GraphNode[]) => {
    nodesArr = n;
  };

  return force;
}

interface SimResult {
  sim: Simulation<GraphNode, GraphLink>;
  cfg: ForceConfig;
}

function makeSim(
  nodes: GraphNode[],
  links: GraphLink[],
  w: number,
  h: number,
  tier: GraphTierConfig,
): SimResult {
  // Two degree maps with distinct jobs. taskDeg (task edges only) drives
  // DRAWN size, so attaching notes never visually inflates a task. allDeg
  // (every edge) drives the physics — charge, collide, hub ring, link
  // stretch — because a task annotated by ten notes IS a physical hub that
  // needs the space, even while drawn small. Splitting these the other way
  // (physics on taskDeg) compressed real graphs into a knot of overlapping
  // satellites; the physics deliberately match the pre-notes tuning.
  const taskDeg = buildLinkCounts(links.filter((l) => !isNoteLinkType(l.type)));
  const allDeg = buildLinkCounts(links);
  const cfg = deriveForceConfig(nodes.length, links.length);
  // Hubs sit on an inner ring of this radius. Their leaves naturally fan
  // outward via the link / charge / collide balance — the ring is just a
  // scaffold that stops every hub from competing for the same point.
  const hubRingR = cfg.linkDistDepends * 1.0;
  const degOf = (id: string) => allDeg.get(id) ?? 0;

  const sim = forceSimulation<GraphNode, GraphLink>(nodes)
    .force(
      "link",
      forceLink<GraphNode, GraphLink>(links)
        .id((n) => n.id)
        .distance((l) => {
          // Note edges ride the relates distance — same spring the quiet
          // task relations use; the hub stretch below spreads dense knots.
          const baseDist =
            l.type === "depends_on" ? cfg.linkDistDepends : cfg.linkDistRelates;
          const srcId = typeof l.source === "string" ? l.source : l.source.id;
          const tgtId = typeof l.target === "string" ? l.target : l.target.id;
          const srcDeg = degOf(srcId);
          const tgtDeg = degOf(tgtId);
          const minDeg = Math.min(srcDeg, tgtDeg);
          const maxDeg = Math.max(srcDeg, tgtDeg);
          // Hub-to-hub edges get the strongest stretch — these are the
          // edges that compress the central knot when both ends try to
          // squeeze into the inner ring. Bonus rises sharply with min-deg.
          const hubHubBonus =
            minDeg >= HUB_THRESHOLD
              ? Math.min(0.55, (minDeg - HUB_THRESHOLD + 1) * 0.1)
              : 0;
          // Hub-to-leaf bonus — gives leaves breathing room around a hub.
          const hubLeafBonus = Math.min(
            0.3,
            Math.sqrt(Math.max(maxDeg - 1, 0)) * 0.06,
          );
          return baseDist * (1 + Math.max(hubHubBonus, hubLeafBonus));
        })
        .iterations(tier.linkIterations),
    )
    .force(
      "charge",
      forceManyBody<GraphNode>()
        .strength((n) => {
          const d = degOf(n.id);
          // Hub bonus on top of the global charge strength: a degree-9 hub
          // now repels ~50% harder than a leaf (was ~30%). Opens the knot
          // around hubs and — combined with the hub-hub link stretch —
          // forces the hubs themselves to spread around the inner ring.
          return cfg.chargeStrength - Math.sqrt(d) * 130;
        })
        .distanceMin(8)
        .distanceMax(cfg.chargeDistanceMax),
    )
    .force(
      "collide",
      forceCollide<GraphNode>()
        .radius((n) => {
          const baseR = getNodeSize(n, taskDeg) + cfg.collidePadding;
          const d = degOf(n.id);
          // Hub bonus — degree-12 hub claims ~60 extra units of personal
          // space. Hub leaves still sit at link-distance (much bigger than
          // this), so the bonus only affects hub-vs-hub spacing — exactly
          // what was making the central cluster crowded.
          if (d < HUB_THRESHOLD) return baseR;
          return baseR + Math.min(60, (d - HUB_THRESHOLD + 1) * 9);
        })
        .strength(0.9)
        .iterations(2),
    )
    // Containment — keep the cluster centred but lighter than before so the
    // radial scaffold can do the structural work instead of pulling
    // everything into a single hairball.
    .force("x", forceX<GraphNode>(w / 2).strength(cfg.centerStrength * 0.55))
    .force("y", forceY<GraphNode>(h / 2).strength(cfg.centerStrength * 0.55))
    // Radial scaffold for hubs only. Pulls high-degree nodes onto an inner
    // ring with strength scaled by how dominant the hub is. Below the
    // threshold the strength is 0 so leaves are free.
    .force(
      "hub",
      forceRadial<GraphNode>(hubRingR, w / 2, h / 2).strength((n) => {
        const d = degOf(n.id);
        if (d < HUB_THRESHOLD) return 0;
        return Math.min(0.18, 0.06 + (d - HUB_THRESHOLD) * 0.018);
      }),
    )
    // Knowledge shelf — unlinked notes settle on a stable outer ring instead
    // of drifting under charge alone. Linked notes get strength 0 and are
    // placed by their edges like any other node.
    .force(
      "noteShelf",
      forceRadial<GraphNode>(hubRingR * 2.4, w / 2, h / 2).strength((n) =>
        n.kind === "note" && degOf(n.id) === 0 ? 0.12 : 0,
      ),
    )
    // Knot-buster — kicks nodes that find themselves wedged between many
    // neighbours toward the empty side of their local crowd. Search radius
    // tracks the collide padding so the heuristic scales with whatever
    // breathing distance the rest of the layout uses.
    .force("decongest", forceDecongest(cfg.collidePadding * 2.0, 3))
    // Crowded graphs need more ticks for the decongestion + radial scaffold
    // to do their work. Dividing the tier's alphaDecay by settleScale
    // stretches the visible settling phase for large N without affecting
    // small projects.
    .alphaDecay(tier.alphaDecay / deriveSettleScale(nodes.length))
    .velocityDecay(VELOCITY_DECAY);
  return { sim, cfg };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Public surface of `useForceSimulation`. */
interface UseForceSimulationReturn {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Lifecycle phase — see {@link SimState}. */
  state: SimState;
  /**
   * Bumps once per topology rebuild. Stable across simulation ticks so it can
   * back React deps that should fire only when the structure changes (e.g.
   * connected-set rebuild, quadtree rebuild) rather than on every tick.
   */
  topologyVersion: number;
  /** Reheat the simulation (e.g. after a node drag). */
  reheat: () => void;
  /** Wipe cached positions and re-run a full live explosion. */
  reset: () => void;
}

/**
 * Force-directed simulation hook with explicit lifecycle states, persistent
 * per-project position cache, and an adaptive per-tier tick budget.
 *
 * Behaviour by mount path:
 * - **No selection, no cache**: full live explosion (`alpha=1`), `settling`
 *   → `settled`. The first paint shows nodes at ring positions and the
 *   simulation animates them outward.
 * - **No selection, cache hit**: synchronous mini-relax (`alpha=0.05`,
 *   30 ticks), `settled` from the very first paint. No visible motion.
 * - **Selection, any cache state**: synchronous pre-tick (cache miss runs
 *   the full `tier.preTickN`, hit runs 30), the selected node is pinned via
 *   `fx`/`fy`, and the lifecycle starts in `focused`. No explosion ever.
 *
 * Status / title updates mutate `GraphNode` objects in place — they never
 * touch the simulation. New nodes added while focused are integrated through
 * a synchronous mini-tick with the focused node pinned, so the camera stays
 * glued and existing positions barely shift.
 *
 * @param projectId - Cache key. Stable across the lifetime of the workspace.
 * @param taskList - Tasks to visualise.
 * @param edges - Edges to draw between tasks.
 * @param noteList - Notes to visualise alongside the tasks.
 * @param noteEdges - Flattened note-note and note-task edges.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param selectedNodeId - Currently selected node id (task or note), or null.
 * @param onTick - Optional notification fired every live simulation tick.
 *   The consumer's render loop reads from the (mutated-in-place) node array,
 *   so the callback's only job is to flag a redraw — no React state update
 *   is performed per tick, avoiding O(n)-per-tick reconciliation work.
 * @returns Live nodes/links plus the lifecycle state and reheat / reset
 *   callbacks the consumer wires into manual controls.
 */
export function useForceSimulation(
  projectId: string,
  taskList: GraphTask[],
  edges: TaskGraphEdge[],
  noteList: NoteGraphSlim[],
  noteEdges: NoteEdge[],
  width: number,
  height: number,
  selectedNodeId: string | null,
  onTick?: () => void,
): UseForceSimulationReturn {
  const tier = useMemo(() => getTierConfig(getDeviceTier()), []);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [state, setState] = useState<SimState>("cold");
  const [topologyVersion, setTopologyVersion] = useState(0);

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const dimsRef = useRef({ width, height });
  /** Latest derived force-config for the active simulation. Read by the
   *  dimension effect so a canvas resize re-anchors `forceX`/`forceY`
   *  without stomping the adaptive `centerStrength * 0.55`. */
  const cfgRef = useRef<ForceConfig | null>(null);
  /** Mirror the latest tick callback into a ref so attached d3-force
   *  handlers don't capture a stale closure. Effect-time write (rather than
   *  render-time) keeps the React Compiler safe-mutation invariant. */
  const onTickRef = useRef<(() => void) | undefined>(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);
  useEffect(() => {
    dimsRef.current = { width, height };
  }, [width, height]);

  // Boolean flag — toggling false → true triggers the topology effect to
  // build the simulation now that the canvas has a real size. Stays `true`
  // through subsequent resizes so the effect doesn't rebuild needlessly.
  const dimsValid = width > 0 && height > 0;

  // Refs mirror latest state for non-reactive consumers (d3 handlers, RAF loop).
  const selectedRef = useRef(selectedNodeId);
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    nodesRef.current = nodes;
    linksRef.current = links;
    selectedRef.current = selectedNodeId;
    projectIdRef.current = projectId;
  });

  // Topology fingerprint — ids + edges only. Statuses and titles go through
  // `propsKey` and never trigger a simulation rebuild.
  const topologyKey = useMemo(() => {
    const ids = taskList
      .map((t) => t.id)
      .sort()
      .join(",");
    const es = edges
      .map((e) => `${e.sourceTaskId}-${e.targetTaskId}-${e.edgeType}`)
      .sort()
      .join(",");
    const nids = noteList
      .map((n) => n.id)
      .sort()
      .join(",");
    // Relation is part of the note-edge identity: a mention upgraded to
    // spec_of arrives as the same endpoint pair with a new type, and only
    // a rebuild restyles the drawn edge.
    const nes = noteEdges
      .map((e) => `${e.sourceId}-${e.targetId}-${e.type}`)
      .sort()
      .join(",");
    return `${ids}|${es}|${nids}|${nes}`;
  }, [taskList, edges, noteList, noteEdges]);

  // Property fingerprint — status / title / note-type / fed changes only.
  // Drives the in-place mutation effect.
  const propsKey = useMemo(() => {
    const ts = taskList
      .map((t) => `${t.id}:${t.status}:${t.title}`)
      .sort()
      .join("|");
    const ns = noteList
      .map((n) => `${n.id}:${n.type}:${n.fed ? 1 : 0}:${n.title}`)
      .sort()
      .join("|");
    return `${ts}||${ns}`;
  }, [taskList, noteList]);

  // -----------------------------------------------------------------------
  // Live-path tick / end handlers — attached on any timer-driven restart.
  //
  // The d3-force simulation mutates each `GraphNode` object in place every
  // tick, so the consumer's render loop already sees the latest positions
  // through the same array reference React handed it on topology rebuild.
  // The tick handler therefore avoids `setNodes`/`setLinks` — those would
  // force a full React re-render at 60 Hz, re-running every memo and effect
  // that reads from the array references for no behavioural gain. Instead
  // we just persist positions to the cross-mount cache and ask the consumer
  // to redraw via a ref callback.
  // -----------------------------------------------------------------------
  const attachLiveHandlers = useCallback(
    (sim: Simulation<GraphNode, GraphLink>, newNodes: GraphNode[]) => {
      // Per-restart counter — each topology rebuild / reheat starts a new
      // closure with `tickCount = 0`, so the stride is independent across
      // simulation restarts.
      let tickCount = 0;
      const writeCache = () => {
        const cache = getProjectCache(projectIdRef.current);
        for (const n of newNodes) {
          if (n.x != null && n.y != null) cache.set(n.id, { x: n.x, y: n.y });
        }
      };
      sim.on("tick.live", () => {
        // Persist positions every 5th tick instead of every tick. The cache
        // exists to repaint at the same place across remounts — losing up to
        // 4 ticks (~80 ms) of motion is invisible because `end.live` always
        // writes the final positions before the simulation goes idle.
        tickCount++;
        if (tickCount % 5 === 0) writeCache();
        onTickRef.current?.();
      });
      sim.on("end.live", () => {
        writeCache();
        // Honour an in-flight focus the simulation didn't know about.
        setState(selectedRef.current ? "focused" : "settled");
      });
    },
    [],
  );

  // Topology effect — (re)build the simulation on structural changes.
  // setState calls disabled at the rule: state tracks the imperative
  // d3-force lifecycle (stop/attach/restart) and can't be derived from props.
  useEffect(() => {
    if (taskList.length === 0 && noteList.length === 0) {
      simRef.current?.stop();
      simRef.current = null;
      nodesRef.current = [];
      linksRef.current = [];
      /* eslint-disable react-hooks/set-state-in-effect */
      setNodes([]);
      setLinks([]);
      setState("cold");
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    // Wait until the canvas has a real size — otherwise the sim spawns
    // around (0, 0) and the radial scaffold + spawn spiral lock to a centre
    // that doesn't match the viewport. The dimension effect below re-runs
    // this branch as soon as ResizeObserver / useLayoutEffect supplies the
    // real width and height.
    if (dimsRef.current.width === 0 || dimsRef.current.height === 0) return;

    const w = dimsRef.current.width;
    const h = dimsRef.current.height;
    const cache = getProjectCache(projectId);
    const { nodes: newNodes, links: newLinks } = buildGraph(
      taskList,
      edges,
      noteList,
      noteEdges,
      w / 2,
      h / 2,
      cache,
    );

    const isFirstBuild = simRef.current === null;
    const allCached = newNodes.every((n) => cache.has(n.id));
    // Focus path requires a real, locatable node. If `selectedRef` points at a
    // task that was deleted in this rebuild, fall through to the cached/live
    // path so the camera unsticks; the parent will clear `selectedNodeId`
    // shortly after via its own delete-handler and the selection effect will
    // re-converge.
    const sel =
      selectedRef.current != null
        ? (newNodes.find((n) => n.id === selectedRef.current) ?? null)
        : null;

    simRef.current?.stop();
    const { sim, cfg } = makeSim(newNodes, newLinks, w, h, tier);
    cfgRef.current = cfg;
    setTopologyVersion((v) => v + 1);

    if (sel) {
      // Focus path — sync pre-tick + pin selection. No live ticks; the
      // camera locks onto the focused node immediately on first paint.
      if (sel.x != null && sel.y != null) {
        sel.fx = sel.x;
        sel.fy = sel.y;
      }
      // Scale pre-tick budget with project size, capped at 1.6× so we never
      // freeze the main thread for more than ~half a second on first paint.
      const settleScale = deriveSettleScale(newNodes.length);
      const fullPreTick = Math.round(
        tier.preTickN * Math.min(1.6, settleScale),
      );
      const ticks = allCached ? MINI_RELAX_TICKS : fullPreTick;
      sim.alpha(allCached ? 0.05 : 1);
      for (let i = 0; i < ticks; i++) sim.tick();
      for (const n of newNodes) {
        if (n.x != null && n.y != null) cache.set(n.id, { x: n.x, y: n.y });
      }
      simRef.current = sim;
      nodesRef.current = newNodes;
      linksRef.current = newLinks;
      setNodes(newNodes);
      setLinks(newLinks);
      setState("focused");
      return () => {
        sim.stop();
      };
    }

    // No selection, all positions known — gentle visible relax instead of
    // a sync mini-tick. The user expects motion every time the graph opens
    // even on return visits; instant placement feels broken.
    if (allCached) {
      attachLiveHandlers(sim, newNodes);
      sim.alpha(0.35).restart();
      simRef.current = sim;
      nodesRef.current = newNodes;
      linksRef.current = newLinks;
      setNodes(newNodes);
      setLinks(newLinks);
      setState("settling");
      return () => {
        sim.stop();
      };
    }

    // Live path — full explosion. Either a first-mount cold start or new
    // uncached nodes mixed in. Existing cached nodes keep their place; only
    // newcomers spread out. `alpha=0.3` for incremental reheats so the
    // existing graph barely shifts when one node is added.
    attachLiveHandlers(sim, newNodes);
    sim.alpha(isFirstBuild ? 1 : 0.3).restart();
    simRef.current = sim;
    nodesRef.current = newNodes;
    linksRef.current = newLinks;
    setNodes(newNodes);
    setLinks(newLinks);
    setState("settling");

    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey, projectId, tier, attachLiveHandlers, dimsValid]);

  // -----------------------------------------------------------------------
  // Property effect — status / title in-place mutation. Never rebuilds.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const ns = nodesRef.current;
    if (ns.length === 0) return;
    const byId = new Map(taskList.map((t) => [t.id, t] as const));
    const noteById = new Map(noteList.map((n) => [n.id, n] as const));
    let changed = false;
    // d3-force keys nodes by object identity; swapping objects resets positions.
    /* eslint-disable react-hooks/immutability */
    for (const n of ns) {
      if (n.kind === "note") {
        const note = noteById.get(n.id);
        if (!note) continue;
        if (n.noteType !== note.type) {
          n.noteType = note.type;
          changed = true;
        }
        if (n.fed !== note.fed) {
          n.fed = note.fed;
          changed = true;
        }
        if (n.title !== note.title) {
          n.title = note.title;
          changed = true;
        }
        continue;
      }
      const t = byId.get(n.id);
      if (!t) continue;
      if (n.status !== t.status) {
        n.status = t.status;
        changed = true;
      }
      if (n.title !== t.title) {
        n.title = t.title;
        changed = true;
      }
    }
    /* eslint-enable react-hooks/immutability */
    if (changed) setNodes([...ns]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsKey]);

  // -----------------------------------------------------------------------
  // Selection effect — pin / unpin and switch lifecycle phase.
  // -----------------------------------------------------------------------
  const prevSelectedRef = useRef<string | null>(selectedNodeId);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    if (prev === selectedNodeId) return;
    prevSelectedRef.current = selectedNodeId;

    const sim = simRef.current;
    const ns = nodesRef.current;
    if (!sim || ns.length === 0) return;

    if (prev) {
      const old = ns.find((n) => n.id === prev);
      if (old) {
        old.fx = null;
        old.fy = null;
      }
    }

    // Same `selectedNodeId` drives different transitions per prior phase;
    // not derivable from props.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (selectedNodeId) {
      const next = ns.find((n) => n.id === selectedNodeId);
      if (next && next.x != null && next.y != null) {
        next.fx = next.x;
        next.fy = next.y;
      }
      sim.stop();
      setState("focused");
    } else {
      // Deselect — leave positions where they are, just transition phase so
      // the consumer animates a fit-to-graph.
      setState("settled");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedNodeId]);

  // -----------------------------------------------------------------------
  // Dimension effect — re-anchor the centring forces with the *current*
  // adaptive strength, not a hardcoded constant. Resizing the canvas should
  // shift the cluster centre, not tighten the centre pull (which would
  // re-crowd large graphs the moment the user opens a side panel).
  // -----------------------------------------------------------------------
  useEffect(() => {
    const sim = simRef.current;
    const cfg = cfgRef.current;
    if (!sim || !cfg) return;
    const strength = cfg.centerStrength * 0.55;
    sim.force("x", forceX<GraphNode>(width / 2).strength(strength));
    sim.force("y", forceY<GraphNode>(height / 2).strength(strength));
  }, [width, height]);

  // -----------------------------------------------------------------------
  // Public callbacks
  // -----------------------------------------------------------------------

  /**
   * Reheat the simulation. Behaviour depends on lifecycle phase:
   * - **Focused**: sync mini-tick with the focus pin retained, state stays
   *   `focused`. Camera does not move. Called after dragging or unpinning a
   *   node while a focus is active.
   * - **Otherwise**: timer-driven restart with live tick / end handlers
   *   reattached. Goes to `settling` and back to `settled` when alpha decays.
   */
  const reheat = useCallback(() => {
    const sim = simRef.current;
    const ns = nodesRef.current;
    if (!sim || ns.length === 0) return;

    if (selectedRef.current) {
      sim.alpha(0.15);
      for (let i = 0; i < MINI_RELAX_TICKS; i++) sim.tick();
      const cache = getProjectCache(projectIdRef.current);
      for (const n of ns) {
        if (n.x != null && n.y != null) cache.set(n.id, { x: n.x, y: n.y });
      }
      // Focus state preserved — never settle while a selection is live.
      // We don't `setNodes` here: the consumer's render loop reads node
      // positions from the (mutated-in-place) array and we just need it to
      // redraw. `onTick` is the same hook that the live tick handler uses.
      onTickRef.current?.();
      return;
    }

    attachLiveHandlers(sim, ns);
    sim.alpha(0.3).restart();
    setState("settling");
  }, [attachLiveHandlers]);

  /**
   * Wipe cached positions, scatter nodes onto the spawn spiral, and run a
   * full live explosion. Bound to the "reset view" control.
   */
  const reset = useCallback(() => {
    const sim = simRef.current;
    const ns = nodesRef.current;
    if (!sim || ns.length === 0) return;
    const w = dimsRef.current.width;
    const h = dimsRef.current.height;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spacing = 30 + 25 * Math.log10(Math.max(ns.length, 10));
    for (let i = 0; i < ns.length; i++) {
      const r = Math.sqrt(i + 0.5) * spacing;
      const angle = i * golden;
      ns[i].x = w / 2 + Math.cos(angle) * r;
      ns[i].y = h / 2 + Math.sin(angle) * r;
      ns[i].vx = 0;
      ns[i].vy = 0;
      ns[i].fx = null;
      ns[i].fy = null;
      ns[i]._enterT = 0;
    }
    getProjectCache(projectIdRef.current).clear();
    attachLiveHandlers(sim, ns);
    sim.alpha(1).restart();
    setState("settling");
  }, [attachLiveHandlers]);

  return { nodes, links, state, topologyVersion, reheat, reset };
}
