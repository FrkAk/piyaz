"use client";

import { useEffect, useRef, useState } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useReducedMotion } from "motion/react";
import {
  easeOutCubic,
  getCanvasTheme,
  hexToRgb,
  RELATES_DASH,
  RELATES_OPACITY,
  statusColor,
  type ThemeColors,
} from "@/components/graph/graphConstants";

/** Demo task node — a real d3-force node plus draw state. */
interface HeroNode extends SimulationNodeDatum {
  id: string;
  title: string;
  status: string;
  size: number;
  /** Loop time (ms) at which the node pops into the scene. */
  appearAt: number;
  /** Entrance progress 0→1; drives the pop scale and alpha. */
  enterT: number;
  /** Hover lift progress 0→1. */
  hoverT: number;
}

/** Demo edge — depends_on draws directional, relates_to draws dashed. */
interface HeroLink extends SimulationLinkDatum<HeroNode> {
  type: "depends_on" | "relates_to";
}

/** Expanding ring emitted when a task changes lifecycle stage. */
interface Ripple {
  nodeId: string;
  color: string;
  start: number;
}

/** One beat of the scripted story loop. */
interface StoryEvent {
  at: number;
  /** Caption line count visible after this beat (0 hides all). */
  step?: number;
  /** Node whose status flips on this beat. */
  nodeId?: string;
  status?: string;
}

const LOOP_MS = 26_400;

/** Loop time at which nodes shrink back out before the rebuild. */
const EXIT_MS = 24_600;

/**
 * The loop: a prompt decomposes the idea into a graph (nodes pop in and
 * attach), early tasks progress in a quick montage, then the core product
 * beat plays — surface the ready task, pick it up, finish it, unblock the
 * downstream task — before everything vanishes and rebuilds.
 */
const STORY: StoryEvent[] = [
  { at: 600, step: 1 },
  { at: 5_200, step: 2 },
  { at: 6_100, nodeId: "POOF-1", status: "done" },
  { at: 6_700, nodeId: "POOF-2", status: "done" },
  { at: 7_300, nodeId: "POOF-3", status: "in_progress" },
  { at: 8_300, step: 3 },
  { at: 9_300, step: 4, nodeId: "POOF-4", status: "ready" },
  { at: 10_800, step: 5, nodeId: "POOF-4", status: "in_progress" },
  { at: 17_000, step: 6, nodeId: "POOF-4", status: "done" },
  { at: 18_600, step: 7, nodeId: "POOF-5", status: "ready" },
  { at: 23_800, step: 0 },
];

/** Statuses of the freshly decomposed graph; the reset target every loop. */
const INITIAL_STATUS: Record<string, string> = {
  "POOF-1": "planned",
  "POOF-2": "planned",
  "POOF-3": "planned",
  "POOF-4": "planned",
  "POOF-5": "planned",
  "POOF-6": "planned",
  "POOF-7": "draft",
};

/** Statuses after the story completes; the reduced-motion static tableau. */
const FINAL_STATUS: Record<string, string> = {
  "POOF-1": "done",
  "POOF-2": "done",
  "POOF-3": "in_progress",
  "POOF-4": "done",
  "POOF-5": "ready",
  "POOF-6": "planned",
  "POOF-7": "draft",
};

/**
 * Build the demo graph for project "Poof" — a disappearing TODO list.
 *
 * @returns Fresh node and link arrays (d3 mutates them in place).
 */
function buildGraph(): { nodes: HeroNode[]; links: HeroLink[] } {
  const spec: Array<[string, string, number, number]> = [
    ["POOF-1", "Model expiring tasks", 15, 1_400],
    ["POOF-2", "Build vanish animation", 14, 1_850],
    ["POOF-3", "Sync vanishes live", 14, 2_300],
    ["POOF-4", "Add self-destruct timers", 18, 2_750],
    ["POOF-5", "Ship undo grace window", 14, 3_200],
    ["POOF-6", "Celebrate empty list", 14, 3_650],
    ["POOF-7", "Midnight purge mode", 13, 4_100],
  ];
  const nodes = spec.map(([id, title, size, appearAt]) => ({
    id,
    title,
    size,
    appearAt,
    status: INITIAL_STATUS[id],
    enterT: 0,
    hoverT: 0,
  }));
  const links: HeroLink[] = [
    { source: "POOF-1", target: "POOF-3", type: "depends_on" },
    { source: "POOF-1", target: "POOF-4", type: "depends_on" },
    { source: "POOF-2", target: "POOF-4", type: "depends_on" },
    { source: "POOF-4", target: "POOF-5", type: "depends_on" },
    { source: "POOF-4", target: "POOF-6", type: "depends_on" },
    { source: "POOF-3", target: "POOF-6", type: "depends_on" },
    { source: "POOF-7", target: "POOF-4", type: "relates_to" },
    { source: "POOF-3", target: "POOF-5", type: "relates_to" },
  ];
  return { nodes, links };
}

/**
 * Create the force simulation tuned for a ~7-node hero constellation.
 *
 * @param nodes - Graph nodes (mutated by d3).
 * @param links - Graph links.
 * @param w - Layout width in CSS pixels.
 * @param h - Layout height in CSS pixels.
 * @returns Stopped simulation; the render loop ticks it manually.
 */
function buildSimulation(
  nodes: HeroNode[],
  links: HeroLink[],
  w: number,
  h: number,
): Simulation<HeroNode, HeroLink> {
  return forceSimulation<HeroNode, HeroLink>(nodes)
    .force(
      "link",
      forceLink<HeroNode, HeroLink>(links)
        .id((n) => n.id)
        .distance((l) => (l.type === "depends_on" ? 130 : 160)),
    )
    .force("charge", forceManyBody<HeroNode>().strength(-480).distanceMax(420))
    .force(
      "collide",
      forceCollide<HeroNode>()
        .radius((n) => n.size + 46)
        .strength(0.9),
    )
    .force("x", forceX<HeroNode>(w / 2).strength(0.08))
    .force("y", forceY<HeroNode>(h / 2).strength(0.1))
    .alphaDecay(0.03)
    .stop();
}

/**
 * Ease-out back — overshoots to ~1.1 then settles; the node "pop".
 *
 * @param t - Progress value between 0 and 1.
 * @returns Eased value peaking slightly above 1.
 */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Edge attach progress — holds at zero through the first third of a node's
 * entrance so the node pops first and its edges fade in after.
 *
 * @param enterT - Node entrance progress 0→1.
 * @returns Eased edge alpha contribution 0→1.
 */
function edgeEnter(enterT: number): number {
  return easeOutCubic(Math.max(0, (enterT - 0.35) / 0.65));
}

/** Radial gradients cached per `color|size`; cleared on theme change. */
interface GradientCaches {
  fill: Map<string, CanvasGradient>;
  halo: Map<string, CanvasGradient>;
}

/**
 * Draw one frame: edges with directional gradients and flow dots, status
 * ripples, then nodes in the workspace canvas vocabulary (halo, body fill,
 * lifecycle ring, ready dot, in-progress pulse) with title + ref labels.
 *
 * @param ctx - 2D context, already DPR-scaled to CSS pixel space.
 * @param w - Canvas width in CSS pixels.
 * @param h - Canvas height in CSS pixels.
 * @param nodes - Simulation nodes.
 * @param links - Simulation links (endpoints resolved to nodes by d3).
 * @param ripples - Live status-change ripples (pruned in place).
 * @param theme - Resolved canvas theme colors.
 * @param caches - Node radial gradient caches (ForceGraph's cache pattern).
 * @param now - `performance.now()` timestamp driving dots and pulses.
 * @param animate - False under reduced motion: skips dots and pulses.
 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nodes: HeroNode[],
  links: HeroLink[],
  ripples: Ripple[],
  theme: ThemeColors,
  caches: GradientCaches,
  now: number,
  animate: boolean,
): void {
  ctx.clearRect(0, 0, w, h);

  for (const l of links) {
    const src = l.source as HeroNode;
    const tgt = l.target as HeroNode;
    if (src.x == null || src.y == null || tgt.x == null || tgt.y == null)
      continue;
    const enterAlpha = Math.min(edgeEnter(src.enterT), edgeEnter(tgt.enterT));
    if (enterAlpha <= 0) continue;

    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    if (l.type === "relates_to") {
      ctx.globalAlpha = enterAlpha * RELATES_OPACITY;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(RELATES_DASH);
      ctx.strokeStyle = theme.noteKnowledge;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }

    const [r, g, b] = hexToRgb(theme.statusPlanned);
    const grad = ctx.createLinearGradient(src.x, src.y, tgt.x, tgt.y);
    grad.addColorStop(
      0,
      `rgba(${Math.min(255, r + 50)},${Math.min(255, g + 50)},${Math.min(255, b + 30)},1)`,
    );
    grad.addColorStop(0.7, `rgba(${r},${g},${b},0.6)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0.25)`);
    ctx.globalAlpha = enterAlpha;
    ctx.lineWidth = 2;
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.stroke();

    const angle = Math.atan2(dy, dx);
    const ax = tgt.x - Math.cos(angle) * (tgt.size + 4);
    const ay = tgt.y - Math.sin(angle) * (tgt.size + 4);
    ctx.fillStyle = theme.statusPlanned;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(
      ax - 10 * Math.cos(angle - 0.5),
      ay - 10 * Math.sin(angle - 0.5),
    );
    ctx.lineTo(
      ax - 10 * Math.cos(angle + 0.5),
      ay - 10 * Math.sin(angle + 0.5),
    );
    ctx.closePath();
    ctx.fill();

    if (animate) {
      const t = now / 1000;
      const startT = src.size / len;
      const endT = 1 - tgt.size / len;
      for (let i = 0; i < 3; i++) {
        const phase = (t * 0.25 + i / 3) % 1;
        const tt = startT + phase * (endT - startT);
        ctx.globalAlpha = Math.sin(phase * Math.PI) * enterAlpha * 0.8;
        ctx.beginPath();
        ctx.arc(src.x + dx * tt, src.y + dy * tt, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    const node = nodes.find((n) => n.id === rp.nodeId);
    const age = (now - rp.start) / 900;
    if (!node || node.x == null || node.y == null || age >= 1) {
      ripples.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = 0.5 * (1 - age);
    ctx.lineWidth = 2;
    ctx.strokeStyle = rp.color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.size + age * 46, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    const t = Math.max(0, Math.min(1, n.enterT));
    if (t <= 0) continue;
    const alpha = easeOutCubic(t);
    const sc = statusColor(n.status, theme);
    const [r, g, b] = hexToRgb(sc);
    const isHollow = n.status === "ready";
    const scale = easeOutBack(t) * (1 + 0.18 * easeOutCubic(n.hoverT));

    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;

    const cacheKey = `${sc}|${n.size}`;
    let halo = caches.halo.get(cacheKey);
    if (!halo) {
      halo = ctx.createRadialGradient(0, 0, n.size * 0.5, 0, 0, n.size * 2.5);
      halo.addColorStop(0, `rgba(${r},${g},${b},${theme.haloAlpha})`);
      halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
      caches.halo.set(cacheKey, halo);
    }
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, n.size * 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, n.size, 0, Math.PI * 2);
    if (isHollow) {
      ctx.fillStyle = `rgba(${r},${g},${b},0.06)`;
    } else {
      let fill = caches.fill.get(cacheKey);
      if (!fill) {
        fill = ctx.createRadialGradient(0, 0, 0, 0, 0, n.size);
        fill.addColorStop(0, `rgba(${r},${g},${b},${theme.fillInnerAlpha})`);
        fill.addColorStop(1, `rgba(${r},${g},${b},${theme.fillOuterAlpha})`);
        caches.fill.set(cacheKey, fill);
      }
      ctx.fillStyle = fill;
    }
    ctx.fill();

    ctx.lineWidth = isHollow ? 2 : 1.5;
    ctx.strokeStyle = `rgba(${r},${g},${b},${isHollow ? 1 : 0.8})`;
    if (n.status === "draft") {
      ctx.setLineDash([2, 4]);
      ctx.globalAlpha = alpha * 0.85;
    } else if (n.status === "in_progress" && animate) {
      ctx.shadowColor = sc;
      ctx.shadowBlur = 6 + Math.sin(now / 400) * 3;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    if (n.status === "ready") {
      ctx.fillStyle = `rgba(${r},${g},${b},1)`;
      ctx.beginPath();
      ctx.arc(0, 0, n.size * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = '500 12px "Inter Variable", "Inter", sans-serif';
    ctx.fillStyle = theme.labelText;
    ctx.fillText(n.title, n.x, n.y + n.size + 9);
    ctx.font =
      '600 10px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace';
    ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
    ctx.fillText(n.id, n.x, n.y + n.size + 26);
  }
  ctx.globalAlpha = 1;
}

/** Caption feed lines; `step` reveals them cumulatively as the story plays. */
const CAPTIONS = [
  <>
    <span style={{ color: "var(--color-accent-light)" }}>❯</span> decompose: a
    todo list where tasks vanish
  </>,
  <>
    <span className="text-text-muted">→</span>{" "}
    <span className="text-text-primary">POOF</span> created
    <span className="text-text-muted"> · 7 tasks · edges wired</span>
  </>,
  <>
    <span style={{ color: "var(--color-accent-light)" }}>❯</span> what should I
    pick up next?
  </>,
  <>
    <span className="text-text-muted">→</span>{" "}
    <span className="text-text-primary">POOF-4</span>
    <span className="text-text-muted"> · ready · on the critical path</span>
  </>,
  <>
    <span style={{ color: "var(--color-progress)" }}>◐</span> claude picked up{" "}
    <span className="text-text-primary">POOF-4</span>
    <span className="text-text-muted"> · lens: agent</span>
  </>,
  <>
    <span style={{ color: "var(--color-done)" }}>✓</span>{" "}
    <span className="text-text-primary">POOF-4</span> done
    <span className="text-text-muted"> · record saved for downstream</span>
  </>,
  <>
    <span className="text-text-muted">→</span>{" "}
    <span className="text-text-primary">POOF-5</span> unblocked
    <span className="text-text-muted"> · queued as next</span>
  </>,
];

/**
 * Interactive auth-hero graph — a live d3-force miniature of a Piyaz
 * project ("Poof", a disappearing TODO list). Each 26s loop the graph
 * builds itself from a decompose prompt (nodes pop in and attach while
 * the sim spreads them out), statuses cascade through the lifecycle, the
 * core find-work → pick-up → done → unblock beat plays, and the whole
 * thing vanishes and starts over. Nodes stay draggable throughout.
 *
 * The scene is a demo, not live data: agents reach real graphs through
 * MCP, the webapp shows artefacts. Reduced motion renders the completed
 * story as a settled static tableau (drag still works). The render loop
 * suspends whenever the container has zero width (hidden breakpoints)
 * and resumes from the ResizeObserver.
 *
 * @returns Full-bleed canvas with the bottom-anchored session-log feed.
 */
export function AuthHeroGraphCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [step, setStep] = useState(0);
  const reducedMotion = useReducedMotion();
  const shownCaptions = reducedMotion ? CAPTIONS.length : step;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { nodes, links } = buildGraph();
    const ripples: Ripple[] = [];
    const caches: GradientCaches = { fill: new Map(), halo: new Map() };
    let theme = getCanvasTheme();
    let w = container.clientWidth;
    let h = container.clientHeight;
    const layoutH = () => Math.max(h - 270, 260);
    const sim = buildSimulation(nodes, links, w, layoutH());
    const reduced = reducedMotion === true;

    let raf = 0;
    let running = false;
    let storyStart = performance.now();
    let eventIdx = 0;
    let dragNode: HeroNode | null = null;
    let hoverNode: HeroNode | null = null;

    /** Re-seed node positions in a tight ring so the build spreads out. */
    const seedPositions = () => {
      const cx = w / 2;
      const cy = layoutH() / 2;
      nodes.forEach((n, i) => {
        n.x = cx + Math.cos(i * 2.4) * 30;
        n.y = cy + Math.sin(i * 2.4) * 30;
        n.vx = 0;
        n.vy = 0;
      });
      sim.alpha(0.9);
    };

    if (reduced) {
      for (const n of nodes) {
        n.status = FINAL_STATUS[n.id];
        n.enterT = 1;
      }
      sim.tick(180);
    } else {
      seedPositions();
    }

    const resize = () => {
      w = container.clientWidth;
      h = container.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sim.force("x", forceX<HeroNode>(w / 2).strength(0.08));
      sim.force("y", forceY<HeroNode>(layoutH() / 2).strength(0.1));
      sim.alpha(Math.max(sim.alpha(), 0.4));
      if (w > 0) startLoop();
    };

    const themeObserver = new MutationObserver(() => {
      theme = getCanvasTheme();
      caches.fill.clear();
      caches.halo.clear();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const resetStory = (now: number) => {
      for (const n of nodes) {
        n.status = INITIAL_STATUS[n.id];
        n.enterT = 0;
      }
      ripples.length = 0;
      seedPositions();
      storyStart = now;
      eventIdx = 0;
    };

    const stepStory = (now: number) => {
      const elapsed = now - storyStart;
      if (elapsed >= LOOP_MS) {
        resetStory(now);
        setStep(0);
        return;
      }
      while (eventIdx < STORY.length && elapsed >= STORY[eventIdx].at) {
        const ev = STORY[eventIdx++];
        if (ev.step != null) setStep(ev.step);
        const node = ev.nodeId && nodes.find((n) => n.id === ev.nodeId);
        if (node && ev.status) {
          node.status = ev.status;
          ripples.push({
            nodeId: node.id,
            color: statusColor(ev.status, theme),
            start: now,
          });
        }
      }
      for (const n of nodes) {
        if (elapsed >= EXIT_MS) {
          n.enterT = Math.max(0, n.enterT - 0.06);
        } else if (elapsed >= n.appearAt) {
          if (n.enterT === 0) sim.alpha(Math.max(sim.alpha(), 0.3));
          n.enterT = Math.min(1, n.enterT + 0.045);
        }
      }
    };

    const frame = (now: number) => {
      if (w === 0) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(frame);
      if (!reduced) {
        stepStory(now);
        for (const n of nodes) {
          const target = n === hoverNode || n === dragNode ? 1 : 0;
          n.hoverT += (target - n.hoverT) * 0.14;
        }
      }
      if (sim.alpha() > sim.alphaMin() || sim.alphaTarget() > 0) sim.tick();
      drawFrame(ctx, w, h, nodes, links, ripples, theme, caches, now, !reduced);
    };

    const startLoop = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const localPoint = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const hitNode = (x: number, y: number): HeroNode | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.x == null || n.y == null || n.enterT < 0.5) continue;
        const dx = x - n.x;
        const dy = y - n.y;
        if (dx * dx + dy * dy <= (n.size + 10) ** 2) return n;
      }
      return null;
    };

    const onWindowMove = (e: PointerEvent) => {
      if (!dragNode) return;
      const [x, y] = localPoint(e);
      dragNode.fx = x;
      dragNode.fy = y;
    };
    const onWindowUp = () => {
      if (!dragNode) return;
      dragNode.fx = null;
      dragNode.fy = null;
      dragNode = null;
      sim.alphaTarget(0);
      canvas.style.cursor = "default";
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (dragNode) return;
      const [x, y] = localPoint(e);
      const node = hitNode(x, y);
      if (!node) return;
      e.preventDefault();
      dragNode = node;
      node.fx = x;
      node.fy = y;
      sim.alphaTarget(0.35);
      canvas.style.cursor = "grabbing";
      window.addEventListener("pointermove", onWindowMove);
      window.addEventListener("pointerup", onWindowUp);
      window.addEventListener("pointercancel", onWindowUp);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragNode) return;
      const [x, y] = localPoint(e);
      hoverNode = hitNode(x, y);
      canvas.style.cursor = hoverNode ? "grab" : "default";
    };
    const onPointerLeave = () => {
      hoverNode = null;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
      sim.stop();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
    };
  }, [reducedMotion]);

  return (
    <div className="relative z-10 h-full w-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-10 pb-12 lg:px-12">
        <div className="mb-3.5 flex items-center gap-2">
          <span
            className="status-pulse inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-accent-2)" }}
          />
          <span
            className="font-mono text-[10px] font-semibold uppercase"
            style={{
              color: "var(--color-accent-light)",
              letterSpacing: "0.14em",
            }}
          >
            Live · Project: Poof
          </span>
        </div>
        <div
          className="font-mono text-[13px] text-text-secondary"
          style={{ lineHeight: 1.85, fontFeatureSettings: '"tnum" 1' }}
        >
          {CAPTIONS.map((line, i) => (
            <div
              key={i}
              className={`transition-[opacity,transform] duration-500 ease-out ${
                i < shownCaptions ? "opacity-100" : "translate-y-1.5 opacity-0"
              }`}
            >
              {line}
            </div>
          ))}
        </div>
        <p className="mt-6 max-w-md text-[12.5px] text-text-muted">
          You bring the idea. Piyaz builds the collaborative workspace.
        </p>
      </div>
    </div>
  );
}
