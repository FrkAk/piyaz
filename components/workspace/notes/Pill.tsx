import type { CSSProperties, ReactNode } from "react";
import { tint } from "./note-meta";

/** Block-shape pill: full-height header/label chip. */
const BLOCK_CLASS =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase";

/** Inline-shape chip: sits on the text baseline inside rendered prose. */
const INLINE_CLASS =
  "inline-flex items-center rounded px-1.5 align-baseline font-mono text-[0.82em]";

interface PillProps {
  /** @param color - Token color driving text, and (when active) the tinted background and border. */
  color: string;
  /** @param icon - Optional leading glyph. */
  icon?: ReactNode;
  /** @param inline - Render the baseline prose-chip shape instead of the header shape. */
  inline?: boolean;
  /** @param active - Tinted when true; transparent with a neutral border when false. Defaults to true. */
  active?: boolean;
  /** @param onClick - When set, renders an interactive button instead of a static span. */
  onClick?: () => void;
  /** @param ariaPressed - Pressed state for toggle buttons. */
  ariaPressed?: boolean;
  /** @param title - Native tooltip. */
  title?: string;
  /** @param className - Extra classes appended to the shape classes. */
  className?: string;
  /** @param children - Pill label. */
  children: ReactNode;
}

/**
 * Color-driven pill used across the notes UI. One `color` prop fans out to
 * the text color and, when active, a tinted background and border via
 * {@link tint}. Renders a static span by default, or a button when `onClick`
 * is set (status/type labels, ref chips, and type-filter toggles).
 *
 * @param props - Color, shape, state, and optional interaction.
 * @returns The pill span or button.
 */
export function Pill({
  color,
  icon,
  inline = false,
  active = true,
  onClick,
  ariaPressed,
  title,
  className,
  children,
}: PillProps) {
  const shape = inline ? INLINE_CLASS : BLOCK_CLASS;
  const classes = [shape, onClick ? "cursor-pointer" : null, className]
    .filter(Boolean)
    .join(" ");
  const style: CSSProperties = active
    ? {
        color,
        background: tint(color, 13),
        border: `1px solid ${tint(color, 28)}`,
      }
    : {
        color,
        background: "transparent",
        border: "1px solid var(--color-border)",
      };

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={ariaPressed}
        title={title}
        className={classes}
        style={style}
      >
        {icon}
        {children}
      </button>
    );
  }

  return (
    <span title={title} className={classes} style={style}>
      {icon}
      {children}
    </span>
  );
}
