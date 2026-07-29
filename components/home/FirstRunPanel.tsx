"use client";

import { GetStartedGuide } from "@/components/home/GetStartedModal";

/**
 * Guided first-run surface rendered in place of the project grid when the
 * signed-in user has zero projects. Inlines {@link GetStartedGuide} so the
 * setup path is the page itself instead of hiding behind the New project
 * button, adds a phones-only pointer to desktop, and closes the loop by
 * naming where the first project will appear.
 * @returns First-run panel for the empty home state.
 */
export function FirstRunPanel() {
  return (
    <div className="mx-auto mb-6 max-w-2xl rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-card)]">
      <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-light">
        First project
      </p>
      <h2 className="mb-4 text-lg font-semibold tracking-tight text-text-primary">
        Two steps to your first project
      </h2>

      <div
        className="mb-4 rounded-lg border p-3 sm:hidden"
        style={{
          borderColor:
            "color-mix(in srgb, var(--color-accent-2) 18%, var(--color-border))",
          background:
            "color-mix(in srgb, var(--color-accent-2) 5%, transparent)",
        }}
      >
        <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
          On your phone?
        </p>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          Piyaz connects from the coding agent on your computer. Open this page
          on that machine to finish setup.
        </p>
      </div>

      <div className="space-y-5">
        <GetStartedGuide />
        <p className="text-xs leading-relaxed text-text-muted">
          Your first project appears right here the moment your agent creates
          it.
        </p>
      </div>
    </div>
  );
}

export default FirstRunPanel;
