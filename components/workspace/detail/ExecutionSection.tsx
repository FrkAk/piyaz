"use client";

import { Markdown } from "@/components/shared/Markdown";
import { SectionHeader } from "@/components/shared/SectionHeader";

interface ExecutionSectionProps {
  /** Execution record markdown, or null when not present. */
  record: string | null | undefined;
}

/**
 * Read-only execution record — surfaces what the agent recorded after
 * implementing the task. Hidden when the record is missing so the section
 * doesn't leave a placeholder gap in the detail flow.
 *
 * @param props - Section configuration.
 * @returns Section element or null.
 */
export function ExecutionSection({ record }: ExecutionSectionProps) {
  if (!record?.trim()) return null;

  return (
    <section className="mb-7">
      <SectionHeader label="Execution record" />
      <div className="rounded-md border border-done/20 bg-done/5 p-3">
        <Markdown className="text-[12.5px] leading-relaxed text-text-secondary">
          {record}
        </Markdown>
      </div>
    </section>
  );
}

export default ExecutionSection;
