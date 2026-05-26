interface DepsHintProps {
  /** `up` for upstream `depends_on`, `down` for downstream. */
  icon: "up" | "down";
  /** Edge count to render. */
  count: number;
}

/**
 * Tiny mono dependency hint — `↑3` for upstream, `↓1` for downstream. The
 * arrow color cues the edge category (depends-on vs related-to). Hidden
 * below `sm` so dense list rows stay readable on narrow viewports.
 *
 * @param props - Direction and count.
 * @returns Inline-flex span rendering arrow + count.
 */
export function DepsHint({ icon, count }: DepsHintProps) {
  return (
    <span
      className="hidden shrink-0 items-center gap-0.5 font-mono text-[10px] text-text-muted sm:inline-flex"
      title={icon === "up" ? `${count} upstream` : `${count} downstream`}
    >
      <span
        style={{
          color: icon === "up" ? "var(--color-depends)" : "var(--color-relates)",
        }}
      >
        {icon === "up" ? "↑" : "↓"}
      </span>
      <span className="tabular-nums">{count}</span>
    </span>
  );
}
