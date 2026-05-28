interface ProjectMarkProps {
  initial: string;
  color: string;
  size?: number;
}

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
