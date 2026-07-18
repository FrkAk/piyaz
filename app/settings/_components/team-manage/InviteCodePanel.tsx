"use client";

import { useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shared/Button";
import { formatAbsolute } from "@/lib/ui/relative-time";
import {
  regenerateTeamInviteCodeAction,
  revokeTeamInviteCodeAction,
  type InviteCodeMetadata,
} from "@/lib/actions/team-invite-code";
import { InlineConfirm } from "@/app/settings/_components/InlineConfirm";

interface InviteCodePanelProps {
  /** Team UUID — passed to every invite-code action. */
  teamId: string;
  /** Current invite-code metadata, or null when none has been minted yet. */
  inviteCode: InviteCodeMetadata | null;
  /** Replace the current invite-code metadata after a rotate/revoke. */
  onChanged: (next: InviteCodeMetadata) => void;
  /** Surface a transient error from any action. */
  onError: (message: string) => void;
}

/**
 * Invite-code panel. Surfaces the team's rotatable join code with copy /
 * rotate / revoke actions. Collapsed by default to keep the email-invite
 * surface primary; expanding reveals the full operational area.
 *
 * Actions are target-scoped on `teamId`, so admins of team T can rotate
 * or revoke T's code from any context — there is no "active team" gate.
 *
 * @param props - Panel state + callbacks.
 * @returns Collapsible card with the current code and actions.
 */
export function InviteCodePanel({
  teamId,
  inviteCode,
  onChanged,
  onError,
}: InviteCodePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [pending, startTransition] = useTransition();

  const handleCopy = async () => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode.code);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch (err) {
      console.error("clipboard write failed", err);
      onError("Could not copy to clipboard.");
    }
  };

  const handleRotate = () => {
    startTransition(async () => {
      const result = await regenerateTeamInviteCodeAction({
        organizationId: teamId,
      });
      if (result.ok) {
        onChanged(result.data);
      } else {
        onError(result.message);
      }
    });
  };

  const handleRevoke = async () => {
    const result = await revokeTeamInviteCodeAction({ organizationId: teamId });
    if (result.ok) {
      onChanged(result.data);
    } else {
      onError(result.message);
    }
  };

  const isRevoked = !!inviteCode?.revokedAt;

  return (
    <section className="rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="invite-code-body"
        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-5 py-4 text-left transition-colors hover:bg-surface-hover"
      >
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Invite code
          </p>
          <p className="mt-0.5 text-sm text-text-primary">
            {isRevoked
              ? "Revoked. Rotate to issue a new code"
              : inviteCode
                ? "One-tap join code for new teammates"
                : "No code yet. Open to mint one"}
          </p>
        </div>
        <motion.svg
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-text-muted"
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <path d="M4.22 5.97a.75.75 0 011.06 0L8 8.69l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.03a.75.75 0 010-1.06z" />
        </motion.svg>
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            id="invite-code-body"
            key="invite-code-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{ overflow: "hidden" }}
          >
            <div className="border-t border-border px-5 py-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div
                  className={`flex-1 rounded-md border px-3 py-2 font-mono text-sm ${
                    isRevoked
                      ? "border-cancelled/25 bg-cancelled/5 text-cancelled line-through"
                      : "border-border bg-base text-text-primary"
                  }`}
                >
                  {inviteCode?.code ?? "—"}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="copy"
                    size="sm"
                    onClick={handleCopy}
                    disabled={!inviteCode || isRevoked}
                  >
                    {copyState === "copied" ? "Copied!" : "Copy"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleRotate}
                    isLoading={pending}
                  >
                    Rotate
                  </Button>
                  {!isRevoked ? (
                    <InlineConfirm
                      trigger={
                        <Button variant="secondary" size="sm">
                          Revoke
                        </Button>
                      }
                      prompt="Revoke this invite code?"
                      body="The current code stops working immediately."
                      confirmLabel="Revoke"
                      destructive
                      onConfirm={handleRevoke}
                    />
                  ) : null}
                </div>
              </div>
              {inviteCode ? (
                <p className="text-xs text-text-muted">
                  Used {inviteCode.useCount}{" "}
                  {inviteCode.useCount === 1 ? "time" : "times"}
                  <span aria-hidden="true"> · </span>
                  Last updated {formatAbsolute(inviteCode.createdAt)}
                </p>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
