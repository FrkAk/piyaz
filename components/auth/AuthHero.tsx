/**
 * Auth hero — bottom-anchored decorative panel for the sign-in / sign-up
 * right column. Static mock of an in-flight agent feed so the marketing
 * promise ("agent-native project graph") reads at first glance.
 *
 * MCP-first principle: the feed is intentionally hardcoded. The webapp
 * never subscribes to live agent presence — agents reach the graph
 * through MCP, the webapp shows artefacts. Nothing here streams.
 *
 * @returns Full-height column with atmosphere gradients and mono terminal block.
 */
export function AuthHero() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 70% 30%, rgba(129, 140, 248, 0.10), transparent 70%), radial-gradient(50% 40% at 30% 80%, rgba(94, 234, 212, 0.07), transparent 70%)",
        }}
      />
      <div className="relative z-10 mt-auto w-full px-10 pb-12 lg:px-12">
        <div className="mb-3.5 flex items-center gap-2">
          <span
            className="status-pulse inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-accent-2)" }}
          />
          <span
            className="font-mono text-[10px] font-semibold uppercase"
            style={{
              color: "var(--color-accent-light)",
              letterSpacing: "0.14em",
            }}
          >
            Live · Project: Mymir
          </span>
        </div>
        <div
          className="font-mono text-[13px] text-text-secondary"
          style={{
            lineHeight: 1.7,
            fontFeatureSettings: '"tnum" 1',
          }}
        >
          <div>
            <span style={{ color: "var(--color-accent-light)" }}>❯</span>{" "}
            claude: I picked up{" "}
            <span className="text-text-primary">MYMR-104</span>
          </div>
          <div className="pl-3.5 text-text-muted">
            → working bundle: 1,284 / 8,000 tokens
          </div>
          <div className="pl-3.5 text-text-muted">
            → surfaced upstream record from MYMR-101
          </div>
          <div className="pl-3.5 text-text-muted">
            → 3/5 acceptance criteria pre-validated
          </div>
          <div className="mt-2.5">
            <span style={{ color: "var(--color-accent-2)" }}>✓</span> agent:
            codex committed <span className="text-text-primary">DOCS-12</span> ·
            12m ago
          </div>
          <div>
            <span style={{ color: "var(--color-progress)" }}>◐</span> agent:
            claude implementing{" "}
            <span className="text-text-primary">MYMR-103</span> · 0:42
          </div>
        </div>
        <p className="mt-6 max-w-md text-[12.5px] text-text-muted">
          What ships looks more like what got shipped to you.
        </p>
      </div>
    </>
  );
}
