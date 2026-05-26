import type { LifecycleStage } from "@/lib/data/views";
import { lifecycleStageToneClass } from "./predicates";

interface LifecycleStagePillProps {
  /** Stage to render. */
  stage: LifecycleStage;
}

/**
 * Mono pill rendering the row's lifecycle stage label (`agent`, `planning`,
 * `working`, `execution`, `draft`). Tones come from existing `--color-glyph-*`
 * tokens via {@link lifecycleStageToneClass}.
 *
 * @param props - Stage value.
 * @returns Inline-flex pill element.
 */
export function LifecycleStagePill({ stage }: LifecycleStagePillProps) {
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center justify-center rounded px-1.5 font-mono text-[9.5px] font-medium lowercase tracking-[0.02em] ${lifecycleStageToneClass(stage)}`}
    >
      {stage}
    </span>
  );
}
