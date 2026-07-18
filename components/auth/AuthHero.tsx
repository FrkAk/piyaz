import { AuthHeroGraph } from "@/components/auth/AuthHeroGraph";

/**
 * Auth hero — the sign-in / sign-up right column: atmosphere gradients
 * behind an interactive d3-force miniature of a Piyaz project graph (see
 * {@link AuthHeroGraph} for the scripted demo loop and the caption feed).
 *
 * @returns Full-height decorative column.
 */
export function AuthHero() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 70% 30%, rgba(151, 107, 104, 0.12), transparent 70%), radial-gradient(50% 40% at 30% 80%, rgba(118, 137, 137, 0.09), transparent 70%)",
        }}
      />
      <AuthHeroGraph />
    </>
  );
}
