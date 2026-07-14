"use client";

import { tint } from "@/components/workspace/notes/note-meta";

interface NoteSquareGlyphProps {
  /** @param color - Ring/tint color (CSS color or token expression). */
  color: string;
  /** @param size - Square edge in px. */
  size?: number;
  /** @param fed - Draw the fed corner dot (`feedMode != 'none'`). */
  fed?: boolean;
}

/**
 * Rounded-square note mark mirroring the canvas note shape: type-colored
 * ring + tinted fill, with a solid corner dot when the note auto-feeds
 * tasks. Shared by the graph rail rows and the mobile list drawer so the
 * mark reads identically everywhere.
 *
 * @param props - Color, size, and fed flag.
 * @returns Inline glyph span.
 */
export function NoteSquareGlyph({
  color,
  size = 10,
  fed = false,
}: NoteSquareGlyphProps) {
  return (
    <span
      aria-hidden
      className="relative inline-block flex-shrink-0 rounded-[3px]"
      style={{
        width: size,
        height: size,
        border: `1.5px solid ${color}`,
        background: tint(color, 20),
      }}
    >
      {fed && (
        <span
          className="absolute rounded-full"
          style={{
            width: 4,
            height: 4,
            top: -2,
            right: -2,
            background: color,
          }}
        />
      )}
    </span>
  );
}

export default NoteSquareGlyph;
