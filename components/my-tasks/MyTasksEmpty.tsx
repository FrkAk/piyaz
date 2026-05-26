"use client";

import Link from "next/link";
import { Kbd } from "@/components/shared/Kbd";
import {
  IconArrowRight,
  IconBundle,
  IconGraph,
  IconInbox,
} from "@/components/shared/icons";

/**
 * Empty-state hero shown when the signed-in user has zero assigned tasks
 * across every team. The graphic stack is purely decorative (orbit rings
 * + Inbox glyph); the operative affordances are the animated CLI hint and
 * the two route buttons routing back to home and the command palette.
 *
 * @returns Centred empty-state block.
 */
export function MyTasksEmpty() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3.5 px-6 pt-14 pb-20 text-center">
      <div aria-hidden="true" className="relative h-24 w-24 [&_*]:absolute">
        <span className="inset-0 m-auto inline-flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border border-border-strong bg-surface-raised text-accent-light shadow-[var(--shadow-card)]">
          <IconInbox size={28} />
        </span>
        <span className="inset-0 m-auto h-[78px] w-[78px] rounded-full border border-dashed border-accent/25" />
        <span className="inset-0 m-auto h-24 w-24 rounded-full border border-dashed border-border" />
      </div>

      <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text-primary">
        Nothing assigned.
      </h2>
      <p className="max-w-[460px] text-[13.5px] leading-[1.55] text-text-muted">
        Ask an agent to plan your next move. Once a task is created in any
        project and assigned to you, it lands here automatically.
      </p>

      <span className="inline-flex items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 py-2.5 font-mono text-[12.5px] whitespace-nowrap shadow-[var(--shadow-card)]">
        <span className="text-text-faint">$</span>
        <span className="font-semibold text-accent-light">/mymir</span>
        <span className="italic tracking-[0.002em] text-text-secondary">
          what&apos;s the next task or critical path I should pick up?
        </span>
        <span aria-hidden="true" className="animate-pulse text-accent-light">
          ▌
        </span>
      </span>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/"
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-surface-raised px-3 text-[12px] font-medium text-text-secondary shadow-[var(--shadow-button)] transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <span className="text-accent-light">
            <IconBundle size={12} />
          </span>
          <span>Browse plannable</span>
          <IconArrowRight size={11} />
        </Link>
        <Link
          href="/"
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-surface-raised px-3 text-[12px] font-medium text-text-secondary shadow-[var(--shadow-button)] transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <span className="text-accent-light">
            <IconGraph size={12} />
          </span>
          <span>Open project graph</span>
          <IconArrowRight size={11} />
        </Link>
      </div>

      <div className="mt-5 text-[12px] text-text-muted">
        Use the <Kbd>⌘K</Kbd> palette to jump to any project.
      </div>
    </section>
  );
}
