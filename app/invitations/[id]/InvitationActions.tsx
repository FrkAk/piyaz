"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/shared/Button";
import {
  acceptEmailInvitationAction,
  rejectEmailInvitationAction,
} from "@/lib/actions/team";

interface InvitationActionsProps {
  /** Invitation UUID driving accept/decline. */
  invitationId: string;
}

/**
 * Accept/Decline pair for the invitation detail card. Accepting joins the
 * team (Better Auth sets the active organization) and lands on `/`;
 * declining marks the row rejected and swaps to a quiet confirmation.
 * Failures surface in the inline danger strip.
 *
 * @param props - The invitation id.
 * @returns Button pair, declined confirmation, or error strip.
 */
export function InvitationActions({ invitationId }: InvitationActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Join the team, then hand navigation to the app's membership gate. */
  async function handleAccept() {
    setError(null);
    setBusy("accept");
    const result = await acceptEmailInvitationAction({ invitationId });
    if (!result.ok) {
      setError(result.message);
      setBusy(null);
      return;
    }
    router.push("/");
    router.refresh();
  }

  /** Mark the invitation rejected so it leaves the team's pending list. */
  async function handleDecline() {
    setError(null);
    setBusy("decline");
    const result = await rejectEmailInvitationAction({ invitationId });
    if (!result.ok) {
      setError(result.message);
      setBusy(null);
      return;
    }
    setDeclined(true);
  }

  if (declined) {
    return (
      <p
        role="status"
        className="rounded-md border border-border bg-base px-3 py-2.5 text-[12.5px] leading-relaxed text-text-secondary"
      >
        Invitation declined. You can close this page, or head to{" "}
        <Link
          href="/"
          className="hover:underline"
          style={{ color: "var(--color-accent-light)" }}
        >
          your workspace
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {error ? (
        <p
          role="alert"
          className="rounded-md border px-3 py-2 text-[12px] text-danger"
          style={{
            background:
              "color-mix(in srgb, var(--color-danger) 10%, transparent)",
            borderColor:
              "color-mix(in srgb, var(--color-danger) 24%, transparent)",
          }}
        >
          {error}
        </p>
      ) : null}
      <div className="flex gap-2.5">
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          isLoading={busy === "decline"}
          disabled={busy !== null}
          onClick={handleDecline}
        >
          Decline
        </Button>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          isLoading={busy === "accept"}
          disabled={busy !== null}
          onClick={handleAccept}
        >
          Accept invitation
        </Button>
      </div>
    </div>
  );
}
