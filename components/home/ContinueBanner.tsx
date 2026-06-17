"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { IconAgent, IconArrowRight } from "@/components/shared/icons";

interface ContinueBannerProps {
  /** @param projectId - UUID or stub ID of the project. */
  projectId: string;
  /** @param projectName - Display name of the project. */
  projectName: string;
  /** @param projectIdentifier - Mono identifier (e.g. `MYMR`). */
  projectIdentifier: string;
  /** @param lastActiveNode - Description of where the user left off. */
  lastActiveNode: string;
  /** @param lastActive - Relative time string (e.g. "2 hours ago"). */
  lastActive: string;
}

/**
 * Banner highlighting the most recently touched project. Renders the
 * gradient accent strip per spec; agent activity is intentionally not
 * surfaced here — agents reach Mymir via MCP, the webapp is the
 * artefact viewer, not a live presence indicator.
 *
 * @param props - Banner data.
 * @returns Linked banner element with a Continue affordance.
 */
export function ContinueBanner({
  projectId,
  projectName,
  projectIdentifier,
  lastActiveNode,
  lastActive,
}: ContinueBannerProps) {
  return (
    <Link href={`/project/${projectId}`} className="block no-underline">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="group relative mb-8 flex items-center gap-4 overflow-hidden rounded-xl border bg-surface px-5 py-4 shadow-[var(--shadow-card)] transition-all hover:shadow-[var(--shadow-card-hover)]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--color-accent) 18%, var(--color-border))",
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 6%, var(--color-surface)) 0%, color-mix(in srgb, var(--color-accent-2) 4%, var(--color-surface)) 100%)",
        }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: "var(--color-accent-grad)" }}
        />

        <span
          aria-hidden="true"
          className="ml-1 inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[9px] border border-border-strong bg-surface-raised text-accent-light"
        >
          <IconAgent size={18} />
        </span>

        <div className="min-w-0 flex-1">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-light">
            Continue where you left off
          </span>
          <p className="mt-0.5 truncate text-[14px] font-medium text-text-primary">
            {projectName}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            <span className="font-mono tabular-nums text-text-secondary">
              {projectIdentifier}
            </span>
            <span className="mx-1.5 text-text-faint">·</span>
            {lastActiveNode}
            <span className="mx-1.5 text-text-faint">·</span>
            {lastActive}
          </p>
        </div>

        <span className="hidden shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised/80 px-3 py-1 text-[12px] font-medium text-text-primary shadow-[var(--shadow-button)] transition-colors group-hover:border-accent/40 sm:inline-flex">
          Continue
          <IconArrowRight size={12} />
        </span>
      </motion.div>
    </Link>
  );
}

export default ContinueBanner;
