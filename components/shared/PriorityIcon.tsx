import type { Priority as SchemaPriority } from '@/lib/types';

/** Re-export the schema priority type, including the unset case. */
export type Priority = SchemaPriority | null;

interface PriorityIconProps {
  /** @param priority - Task priority. `null` renders three muted bars. */
  priority: Priority;
  /** @param className - Optional extra classes. */
  className?: string;
}

/**
 * Three ascending bars indicating priority level. Maps the four-value
 * schema vocabulary (`release-blocker` / `core` / `normal` / `backlog`)
 * to bar count + color. `release-blocker` and `core` both fill 3 bars,
 * so `release-blocker` also gets a danger glow on the tallest bar to
 * distinguish it without relying on hue alone.
 *
 * - `release-blocker` fills 3 bars (danger red, tallest bar glows).
 * - `core` fills 3 bars (blocked red).
 * - `normal` fills 2 bars (amber).
 * - `backlog` fills 1 bar (muted).
 * - `null` renders three border-only bars to reserve space without committing to a value.
 *
 * @param props - Priority and optional className.
 * @returns A small inline-flex SVG-like span with three bars.
 */
export function PriorityIcon({ priority, className }: PriorityIconProps) {
  const filled =
    priority === 'release-blocker' || priority === 'core'
      ? 3
      : priority === 'normal'
        ? 2
        : priority === 'backlog'
          ? 1
          : 0;

  const color =
    priority === 'release-blocker'
      ? 'var(--color-danger)'
      : priority === 'core'
        ? 'var(--color-glyph-blocked)'
        : priority === 'normal'
          ? 'var(--color-glyph-progress)'
          : priority === 'backlog'
            ? 'var(--color-text-muted)'
            : 'var(--color-border-strong)';

  return (
    <span
      className={`inline-flex items-end gap-[2px] ${className ?? ''}`}
      style={{ height: 12 }}
      aria-label={priority ? `Priority: ${priority}` : 'Priority: none'}
    >
      {[1, 2, 3].map((i) => {
        const glow = priority === 'release-blocker' && i === 3;
        return (
          <span
            key={i}
            style={{
              width: 3,
              height: i * 4,
              background: i <= filled ? color : 'var(--color-border-strong)',
              borderRadius: 1,
              opacity: i <= filled ? 1 : 0.6,
              boxShadow: glow
                ? '0 0 4px color-mix(in srgb, var(--color-danger) 90%, transparent), 0 0 10px color-mix(in srgb, var(--color-danger) 55%, transparent)'
                : undefined,
            }}
          />
        );
      })}
    </span>
  );
}

export default PriorityIcon;
