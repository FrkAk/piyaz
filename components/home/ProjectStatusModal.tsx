"use client";

import { Modal } from "@/components/shared/Modal";
import { CopyButton } from "@/components/shared/CopyButton";

export type CliManagedStatus = "brainstorming" | "decomposing";

interface ProjectStatusModalProps {
  /** @param open - Whether the modal is visible. */
  open: boolean;
  /** @param onClose - Called when the modal requests dismissal. */
  onClose: () => void;
  /** @param status - CLI-managed project lifecycle status. */
  status: CliManagedStatus;
  /** @param title - Project title displayed in the modal body. */
  title: string;
  /** @param identifier - Project identifier interpolated into the resume prompt. */
  identifier: string;
}

interface StatusContent {
  modalTitle: string;
  label: string;
  summary: string;
  whatHappens: string;
  prompt: string;
  unlocks: string;
  accentClass: string;
}

const STATUS_CONTENT: Record<CliManagedStatus, StatusContent> = {
  brainstorming: {
    modalTitle: "Idea in progress",
    label: "Brainstorming",
    summary:
      "Your coding agent is shaping the brief: goals, constraints, and what to scope first.",
    whatHappens:
      "Brainstorming captures decisions until the idea is concrete enough to break into tasks.",
    prompt: "Continue brainstorming the {identifier} project ({title}).",
    unlocks:
      "Decomposition unlocks once the brief is solid; the workspace unlocks once the agent activates the project.",
    accentClass: "text-accent border-accent/25 bg-accent/15",
  },
  decomposing: {
    modalTitle: "Structure in progress",
    label: "Decomposing",
    summary:
      "Your coding agent is turning the brief into tasks, criteria, and dependency edges.",
    whatHappens:
      "Decomposition writes the graph the workspace uses for planning, tracking, and execution context.",
    prompt: "Continue decomposing the {identifier} project ({title}).",
    unlocks:
      "When the graph is ready, the agent activates the project, and that opens the workspace.",
    accentClass: "text-progress border-progress/25 bg-progress/15",
  },
};

const SECTION_LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted";

/**
 * Status dialog for projects still owned by a CLI lifecycle phase. Shows what
 * the agent is doing, a copy-ready resume prompt, and what unlocks next.
 * @param props - Modal configuration and project metadata.
 * @returns Status-aware modal with a CLI resume hint.
 */
export function ProjectStatusModal({
  open,
  onClose,
  status,
  title,
  identifier,
}: ProjectStatusModalProps) {
  const content = STATUS_CONTENT[status];
  const promptText = content.prompt
    .replace("{identifier}", identifier)
    .replace("{title}", title);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={content.modalTitle}
      maxWidth="md"
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <div
            className={`inline-flex rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${content.accentClass}`}
          >
            {content.label}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              {content.summary}
            </p>
          </div>
        </div>

        <section className="rounded-lg border border-border bg-surface-raised p-3">
          <h4 className={SECTION_LABEL_CLASS}>What is happening</h4>
          <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
            {content.whatHappens}
          </p>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <h4 className={SECTION_LABEL_CLASS}>Resume prompt</h4>
            <CopyButton text={promptText} />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs leading-relaxed text-text-primary">
            <code>{promptText}</code>
          </pre>
          <p className="text-xs leading-relaxed text-text-muted">
            Paste into your coding agent with the piyaz plugin installed.
          </p>
        </section>

        <section className="space-y-1.5">
          <h4 className={SECTION_LABEL_CLASS}>What unlocks next</h4>
          <p className="text-xs leading-relaxed text-text-muted">
            {content.unlocks}
          </p>
        </section>
      </div>
    </Modal>
  );
}

export default ProjectStatusModal;
