'use client';

import { StatusGlyph, STATUS_META, type TaskStatus } from './StatusGlyph';

interface EdgeMeta {
  label: string;
  cssVar: string;
  /** Tiny dot, no glyph. */
  glyph: 'dot';
}

const EDGE_META: Record<string, EdgeMeta> = {
  depends_on: { label: 'Depends on', cssVar: 'var(--color-depends)', glyph: 'dot' },
  relates_to: { label: 'Relates to', cssVar: 'var(--color-relates)', glyph: 'dot' },
  blocks:     { label: 'Blocks',     cssVar: 'var(--color-glyph-blocked)', glyph: 'dot' },
  parent_of:  { label: 'Parent of',  cssVar: 'var(--color-text-muted)', glyph: 'dot' },
};

interface BadgeProps {
  /** @param status - Task status (`draft|planned|ready|in_progress|in_review|blocked|done|cancelled`) or edge type. */
  status: string;
  /** @param dense - Slightly smaller pill (used inline in dense lists). */
  dense?: boolean;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/**
 * Status / edge-type badge: glyph (or coloured dot) plus a mono uppercase label.
 *
 * @param props - Badge props with status and optional className.
 * @returns A pill-shaped span coloured by the status' glyph variable.
 */
export function Badge({ status, dense = false, className = '' }: BadgeProps) {
  const taskMeta = STATUS_META[status as TaskStatus];
  const edgeMeta = !taskMeta ? EDGE_META[status] : undefined;
  const meta = taskMeta ?? edgeMeta;

  const label = meta?.label ?? status.replace(/[_-]/g, ' ');
  const color = taskMeta?.cssVar ?? edgeMeta?.cssVar ?? 'var(--color-text-muted)';
  const isCancelled = status === 'cancelled';

  return (
    <span
      role="status"
      aria-label={`Status: ${label}`}
      className={`inline-flex items-center gap-1.5 rounded-md font-mono uppercase ${className}`}
      style={{
        height: dense ? 18 : 22,
        padding: dense ? '0 6px' : '0 8px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.06em',
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
        textDecoration: isCancelled ? 'line-through' : undefined,
      }}
    >
      {taskMeta ? (
        <StatusGlyph status={status as TaskStatus} size={dense ? 9 : 10} />
      ) : (
        <span style={{ width: 6, height: 6, borderRadius: 999, background: color, flexShrink: 0 }} aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  );
}

export default Badge;
