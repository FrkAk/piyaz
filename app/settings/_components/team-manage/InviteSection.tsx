"use client";

import type { InvitationView } from "@/lib/actions/team-invitations-map";
import type { InviteCodeMetadata } from "@/lib/actions/team-invite-code";
import { InviteForm } from "./InviteForm";
import { PendingInvitationsList } from "./PendingInvitationsList";
import { InviteCodePanel } from "./InviteCodePanel";

interface InviteSectionProps {
  /** Team UUID — passed to every target-scoped action. */
  teamId: string;
  /** Pending invitations to render. */
  invitations: InvitationView[];
  /** Current invite-code metadata, or null when none has been minted. */
  inviteCode: InviteCodeMetadata | null;
  /** Whether the deploy can send email; gates the pending-list Resend action. */
  emailEnabled: boolean;
  /** Refresh the pending list after invite/cancel. */
  onInvitationsChanged: () => Promise<void>;
  /** Replace the invite-code metadata after rotate/revoke. */
  onInviteCodeChanged: (next: InviteCodeMetadata) => void;
  /** Refresh the invite-code from the server (lazy-fetch path). */
  onRefreshInviteCode: () => Promise<void>;
  /** Refresh the members list (in case an accepted invite landed via SSE). */
  onRefreshMembers: () => Promise<void>;
  /** Surface a transient error from any sub-panel. */
  onError: (message: string) => void;
}

/**
 * Invitations section — composite of email-invite form, pending-list,
 * and invite-code panel. Visible only to admin + owner.
 *
 * @param props - Section state + callbacks.
 * @returns Three sub-panels under a single section heading.
 */
export function InviteSection({
  teamId,
  invitations,
  inviteCode,
  emailEnabled,
  onInvitationsChanged,
  onInviteCodeChanged,
  onRefreshMembers,
  onError,
}: InviteSectionProps) {
  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Invitations
      </p>
      <div className="space-y-4">
        <InviteForm
          teamId={teamId}
          onInvited={async () => {
            await onInvitationsChanged();
            await onRefreshMembers();
          }}
          onError={onError}
        />
        <PendingInvitationsList
          organizationId={teamId}
          invitations={invitations}
          emailEnabled={emailEnabled}
          onChanged={onInvitationsChanged}
          onError={onError}
        />
        <InviteCodePanel
          teamId={teamId}
          inviteCode={inviteCode}
          onChanged={onInviteCodeChanged}
          onError={onError}
        />
      </div>
    </section>
  );
}
