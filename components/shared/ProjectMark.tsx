interface ProjectMarkProps {
  /** Single uppercase glyph rendered inside the mark. */
  initial: string;
  /** CSS colour string from `projectColor()` (typically `hsl(...)`). */
  color: string;
  /** Square dimension in pixels. Default 16. */
  size?: number;
}

/**
 * Square chip with a single mono initial on a per-project gradient. Used
 * inline anywhere a project needs identifying without spelling out the
 * full title — row leading slot, pickup banner meta, etc. The home grid's
 * `BrandMark` is a 28px composition over this primitive.
 *
 * @param props - Initial glyph, base colour, and pixel dimension.
 * @returns Inline-flex square element.
 */
export function ProjectMark({ initial, color, size = 16 }: ProjectMarkProps) {
  const background = `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 50%, var(--color-accent-2)))`;
  const fontSize = Math.max(8, Math.round(size * 0.55));
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-[5px] font-mono font-bold"
      style={{
        width: size,
        height: size,
        background,
        color: "rgba(0, 0, 0, 0.7)",
        fontSize,
      }}
    >
      {initial}
    </span>
  );
}
