"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shared/Button";
import { formatAbsolute } from "@/lib/ui/relative-time";
import { roleStyle } from "@/lib/ui/role-badge";
import {
  cancelInvitationAction,
  resendInvitationAction,
} from "@/lib/actions/team-invitations";
import type { InvitationView } from "@/lib/actions/team-invitations-map";
import { InlineConfirm } from "@/app/settings/_components/InlineConfirm";

interface PendingInvitationsListProps {
  /** Team UUID — used to bind the cancel call to the invitation's org. */
  organizationId: string;
  /** Invitations currently in `pending` state. Already filtered server-side. */
  invitations: InvitationView[];
  /** Whether the deploy can send email; gates the Resend action. */
  emailEnabled: boolean;
  /** Called after a successful cancel or resend to refresh the list. */
  onChanged: () => Promise<void> | void;
  /** Surface a transient error from any cancel or resend. */
  onError: (message: string) => void;
}

/**
 * Format the time-until-expiry for an upcoming date. Returns "in Xd",
 * "in Xh", "soon" — purpose-built for invitation expiry copy. Falls back
 * to absolute date for >30d.
 */
function formatExpiry(date: Date): string {
  const sec = Math.round((date.getTime() - Date.now()) / 1000);
  if (sec <= 0) return "expired";
  if (sec < 3600) return `in ${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `in ${Math.round(sec / 3600)}h`;
  if (sec < 86400 * 30) return `in ${Math.round(sec / 86400)}d`;
  return formatAbsolute(date);
}

/**
 * Pending invitations panel. Lists every still-actionable invitation with
 * an inline-confirm Cancel and, on email-capable deploys, a Resend that
 * refreshes the expiry window and refires the invitation email. Empty
 * state surfaces a quiet message rather than hiding the section, so
 * admins always see how many invites are out.
 *
 * @param props - List + capability flag + change callbacks.
 * @returns Section card with optional list of invitation rows.
 */
export function PendingInvitationsList({
  organizationId,
  invitations,
  emailEnabled,
  onChanged,
  onError,
}: PendingInvitationsListProps) {
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);

  const handleCancel = async (id: string) => {
    const result = await cancelInvitationAction({
      invitationId: id,
      organizationId,
    });
    if (!result.ok) {
      onError(result.message);
      return;
    }
    await onChanged();
  };

  const handleResend = async (id: string) => {
    setResendingId(id);
    const result = await resendInvitationAction({
      invitationId: id,
      organizationId,
    });
    setResendingId(null);
    if (!result.ok) {
      onError(result.message);
      return;
    }
    setSentId(id);
    window.setTimeout(() => setSentId(null), 2000);
    await onChanged();
  };

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Pending invitations · {invitations.length}
      </p>
      {invitations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface/40 p-5 text-center">
          <p className="text-sm text-text-muted">No pending invitations.</p>
          <p className="mt-1 text-xs text-text-muted">
            Send an invite above and it&apos;ll show up here until accepted.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
          <motion.ul layout className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {invitations.map((invitation) => {
                const role = roleStyle(invitation.role);
                return (
                  <motion.li
                    key={invitation.id}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary break-all">
                          {invitation.email}
                        </p>
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${role.bg} ${role.text}`}
                        >
                          {role.dot ? (
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${role.dot}`}
                            />
                          ) : null}
                          {role.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-text-muted">
                        Invited by {invitation.inviterName}
                        <span aria-hidden="true"> · </span>
                        Expires {formatExpiry(invitation.expiresAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {emailEnabled ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={resendingId === invitation.id}
                          disabled={resendingId !== null || sentId !== null}
                          onClick={() => handleResend(invitation.id)}
                        >
                          {sentId === invitation.id ? "Sent" : "Resend"}
                        </Button>
                      ) : null}
                      <InlineConfirm
                        trigger={
                          <Button variant="secondary" size="sm">
                            Cancel
                          </Button>
                        }
                        prompt={`Cancel invite for ${invitation.email}?`}
                        body="They'll need a fresh invitation to join."
                        confirmLabel="Cancel invite"
                        destructive
                        onConfirm={() => handleCancel(invitation.id)}
                      />
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </motion.ul>
        </div>
      )}
    </section>
  );
}
