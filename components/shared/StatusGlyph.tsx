/**
 * Lifecycle stages the workspace renders.
 *
 * Schema statuses: `draft` | `planned` | `in_progress` | `done` | `cancelled`.
 * Derived sub-stages: `plannable` (a draft with criteria + done deps), `ready`
 * (a planned task with done deps), `blocked` (a planned task whose deps are
 * not done — surfaced where the structure list groups it). Sub-stages only
 * appear when the caller derives them — schema status alone never produces
 * `plannable` / `ready` / `blocked`.
 */
export type TaskStatus =
  | 'draft'
  | 'plannable'
  | 'planned'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

interface StatusMeta {
  label: string;
  /** Glyph visual style. */
  glyph: 'dashed' | 'ring' | 'ring-bold' | 'half' | 'three-quarter' | 'blocked' | 'filled' | 'x';
  /** CSS variable holding the fill colour for this status. */
  cssVar: string;
}

/**
 * Static metadata for every lifecycle stage — labels, glyph kind, and CSS
 * colour variable.
 *
 * Visual convention (matched on the graph canvas):
 *   dashed ring          → spec stage, criteria still being met (draft, plannable)
 *   solid ring           → committed plan, may still be waiting on deps (planned)
 *   solid ring + dot     → committed plan AND deps done — agent can fire (ready)
 *   half (50% pie)       → in_progress, amber
 *   three-quarter (270°) → in_review, violet — "about to turn done"
 *   filled + check       → done, green
 *   bar / x              → terminal exception (blocked, cancelled)
 *
 * `plannable` and `ready` share the planned blue colour but get DIFFERENT
 * shapes: plannable is dashed (still in drafting territory), ready is the
 * filled-dot variant (queued, all-clear). The operator can scan for the
 * solid-ring-with-dot to see what an agent could pick up next.
 */
export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  draft:       { label: 'Draft',       glyph: 'dashed',    cssVar: 'var(--color-glyph-draft)' },
  plannable:   { label: 'Plannable',   glyph: 'dashed',    cssVar: 'var(--color-glyph-planned)' },
  planned:     { label: 'Planned',     glyph: 'ring',      cssVar: 'var(--color-glyph-planned)' },
  // Ready borrows the in-progress palette: it's the staging lane that
  // flips to in_progress next, so the warm colour tells the operator
  // "this is the one an agent is about to pick up" without reading text.
  ready:       { label: 'Ready',       glyph: 'ring-bold', cssVar: 'var(--color-glyph-progress)' },
  in_progress: { label: 'In Progress', glyph: 'half',      cssVar: 'var(--color-glyph-progress)' },
  in_review:   { label: 'In Review',   glyph: 'three-quarter', cssVar: 'var(--color-glyph-review)' },
  blocked:     { label: 'Blocked',     glyph: 'blocked',   cssVar: 'var(--color-glyph-blocked)' },
  done:        { label: 'Done',        glyph: 'filled',    cssVar: 'var(--color-glyph-done)' },
  cancelled:   { label: 'Cancelled',   glyph: 'x',         cssVar: 'var(--color-glyph-cancelled)' },
};

interface StatusGlyphProps {
  /** @param status - Task status. Falls back to `draft` if unknown. */
  status: TaskStatus | string;
  /** @param size - Pixel dimension. Defaults to 14. */
  size?: number;
  /** @param className - Optional extra classes. */
  className?: string;
}

/**
 * SVG status glyph used in lists, graph nodes, and pill badges.
 * Each lifecycle status renders as a distinct shape (dashed / ring / half / pulse / filled / blocked / x).
 *
 * @param props - Status, optional size and className.
 * @returns A 1:1 SVG element coloured by the status' CSS variable.
 */
export function StatusGlyph({ status, size = 14, className }: StatusGlyphProps) {
  const meta = STATUS_META[status as TaskStatus] ?? STATUS_META.draft;
  const half = size / 2;
  const r = half - 1.5;
  const c = meta.cssVar;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      style={{ flexShrink: 0 }}
      aria-label={meta.label}
      role="img"
    >
      {meta.glyph === 'dashed' && (
        <circle cx={half} cy={half} r={r} fill="none" stroke={c} strokeWidth={1.4} strokeDasharray="2 2" opacity={0.85} />
      )}
      {meta.glyph === 'ring' && (
        <circle cx={half} cy={half} r={r} fill="none" stroke={c} strokeWidth={1.6} />
      )}
      {meta.glyph === 'ring-bold' && (
        <>
          <circle cx={half} cy={half} r={r} fill="none" stroke={c} strokeWidth={1.6} />
          <circle cx={half} cy={half} r={r * 0.4} fill={c} />
        </>
      )}
      {meta.glyph === 'half' && (
        <>
          <circle cx={half} cy={half} r={r} fill="none" stroke={c} strokeWidth={1.6} />
          <path d={`M ${half} ${half - r} A ${r} ${r} 0 0 1 ${half} ${half + r} Z`} fill={c} />
        </>
      )}
      {meta.glyph === 'three-quarter' && (
        <>
          <circle cx={half} cy={half} r={r} fill="none" stroke={c} strokeWidth={1.6} />
          <path
            d={`M ${half} ${half} L ${half} ${half - r} A ${r} ${r} 0 1 1 ${half - r} ${half} Z`}
            fill={c}
          />
        </>
      )}
      {meta.glyph === 'blocked' && (
        <>
          <circle cx={half} cy={half} r={r} fill="none" stroke={c} strokeWidth={1.6} />
          <line x1={half - r * 0.55} y1={half} x2={half + r * 0.55} y2={half} stroke={c} strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
      {meta.glyph === 'filled' && (
        <>
          <circle cx={half} cy={half} r={r} fill={c} />
          <path
            d={`M ${half - r * 0.5} ${half} L ${half - r * 0.1} ${half + r * 0.4} L ${half + r * 0.55} ${half - r * 0.35}`}
            fill="none"
            stroke="var(--color-base)"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {meta.glyph === 'x' && (
        <>
          <circle cx={half} cy={half} r={r} fill="none" stroke={c} strokeWidth={1.4} opacity={0.6} />
          <line x1={half - r * 0.45} y1={half - r * 0.45} x2={half + r * 0.45} y2={half + r * 0.45} stroke={c} strokeWidth={1.5} strokeLinecap="round" />
          <line x1={half + r * 0.45} y1={half - r * 0.45} x2={half - r * 0.45} y2={half + r * 0.45} stroke={c} strokeWidth={1.5} strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export default StatusGlyph;
