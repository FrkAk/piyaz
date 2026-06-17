/**
 * Brand stamp shown at the top of every auth form — 30×30 gradient `m` mark
 * paired with a lowercase `piyaz` wordmark. Slightly larger than the
 * sidebar variant (22×22) because the auth surface is a destination, not
 * a chrome accessory.
 *
 * @returns Inline-flex brand row.
 */
export function AuthBrand() {
  return (
    <div className="mb-8 flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="inline-flex h-[30px] w-[30px] items-center justify-center font-mono text-[15px] font-bold"
        style={{
          background: "var(--color-accent-grad)",
          borderRadius: 7,
          color: "#0b0c10",
        }}
      >
        m
      </span>
      <span
        className="text-[16px] font-semibold text-text-primary"
        style={{ letterSpacing: "-0.005em" }}
      >
        piyaz
      </span>
    </div>
  );
}
