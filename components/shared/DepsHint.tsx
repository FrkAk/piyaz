interface DepsHintProps {
  icon: "up" | "down";
  count: number;
}

export function DepsHint({ icon, count }: DepsHintProps) {
  return (
    <span
      className="hidden shrink-0 items-center gap-0.5 font-mono text-[10px] text-text-muted sm:inline-flex"
      title={icon === "up" ? `${count} upstream` : `${count} downstream`}
    >
      <span
        style={{
          color:
            icon === "up" ? "var(--color-depends)" : "var(--color-relates)",
        }}
      >
        {icon === "up" ? "↑" : "↓"}
      </span>
      <span className="tabular-nums">{count}</span>
    </span>
  );
}
