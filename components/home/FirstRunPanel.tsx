"use client";

import { GetStartedGuide } from "@/components/home/GetStartedModal";
import { IconSpark } from "@/components/shared/icons";

/**
 * Guided first-run surface rendered in place of the project grid when the
 * signed-in user has zero projects. Mirrors the MyTasksEmpty composition:
 * layered dashed-ring badge, statement heading, and muted explainer above the
 * inlined {@link GetStartedGuide}, with a phones-only callout pointing mobile
 * signups to their computer.
 * @returns First-run panel for the empty home state.
 */
export function FirstRunPanel() {
  return (
    <section className="flex flex-col items-center gap-3.5 px-2 pt-8 pb-16 text-center sm:px-6">
      <div aria-hidden="true" className="relative h-24 w-24 [&_*]:absolute">
        <span className="inset-0 m-auto inline-flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border border-border-strong bg-surface-raised text-accent-light shadow-[var(--shadow-card)]">
          <IconSpark size={28} />
        </span>
        <span className="inset-0 m-auto h-[78px] w-[78px] rounded-full border border-dashed border-accent/25" />
        <span className="inset-0 m-auto h-24 w-24 rounded-full border border-dashed border-border" />
      </div>

      <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text-primary">
        No projects yet.
      </h2>
      <p className="max-w-[460px] text-[13.5px] leading-[1.55] text-text-muted">
        Projects start in your coding agent, next to your code. Set Piyaz up
        once, then create every project by talking to your agent.
      </p>

      <div
        className="w-full max-w-md rounded-lg border p-3 text-left sm:hidden"
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

      <div className="mt-2 w-full max-w-3xl space-y-5 text-left">
        <GetStartedGuide />
      </div>

      <p className="mt-2 text-[12px] text-text-muted">
        Your first project appears right here the moment your agent creates it.
      </p>
    </section>
  );
}

export default FirstRunPanel;
