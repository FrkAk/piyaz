/** Deterministic 5-stop palette used to colour initial-only avatars. */
const AVATAR_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["#c2a4a1", "#9db2ab"],
  ["#c98da4", "#d9a778"],
  ["#8fbca6", "#8fa9cf"],
  ["#d9b878", "#cf8d84"],
  ["#a578a1", "#84aab4"],
];

interface AvatarProps {
  /** @param name - Display name; first 1-2 characters become the initials. */
  name?: string | null;
  /** @param src - Optional image URL. When present, renders an `<img>` instead of initials. */
  src?: string | null;
  /** @param size - Pixel diameter. Defaults to 22. Recommended sizes: 18 / 22 / 28 / 56. */
  size?: number;
  /** @param ring - Render a 2px surface ring around the avatar (used for stacked groups). */
  ring?: boolean;
  /** @param accent - When true, ignore palette and use the brand gradient (used for the signed-in user). */
  accent?: boolean;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/**
 * Pick a stable palette index from a name.
 * @param name - Identifier the colour is keyed on.
 * @returns Index into `AVATAR_PALETTE`.
 */
function paletteIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) % AVATAR_PALETTE.length;
  }
  return h;
}

/**
 * Compose initials from a display name (max two characters).
 * @param name - Name to abbreviate.
 * @returns Uppercase initials, falling back to "?" when empty.
 */
function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return "?";
  return parts
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

/**
 * Round avatar with mono-rendered initials and a deterministic gradient background.
 * @param props - Avatar configuration.
 * @returns A round avatar element sized via `size`.
 */
export function Avatar({
  name,
  src,
  size = 22,
  ring = false,
  accent = false,
  className = "",
}: AvatarProps) {
  const safeName = (name ?? "").trim() || "?";
  const idx = paletteIndex(safeName);
  const [c1, c2] = AVATAR_PALETTE[idx];
  const initials = initialsFor(safeName);

  const background = accent
    ? "var(--color-accent-grad)"
    : `linear-gradient(135deg, ${c1}, ${c2})`;

  if (src) {
    return (
      <span
        className={`inline-flex items-center justify-center overflow-hidden rounded-full ${className}`}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          boxShadow: ring ? "0 0 0 2px var(--color-surface)" : undefined,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- avatar images are 18-56px, next/image optimization is overkill and external OAuth avatars require remote pattern config */}
        <img
          src={src}
          alt={safeName === "?" ? "" : safeName}
          width={size}
          height={size}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={safeName === "?" ? "Unknown user" : safeName}
      className={`inline-flex items-center justify-center rounded-full font-mono ${className}`}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        background,
        color: "rgba(0,0,0,0.65)",
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        letterSpacing: "0.01em",
        boxShadow: ring ? "0 0 0 2px var(--color-surface)" : undefined,
      }}
    >
      {initials}
    </span>
  );
}

export default Avatar;
