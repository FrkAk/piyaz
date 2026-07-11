"use client";

import { useTransition } from "react";
import { Button } from "@/components/shared/Button";
import { formatAbsolute } from "@/lib/ui/relative-time";
import {
  recordDpaAcceptanceAction,
  type DpaAcceptanceState,
} from "@/lib/actions/legal";

interface DpaSectionProps {
  /** Team UUID — the explicit org the owner accepts the DPA for. */
  organizationId: string;
  /** Current acceptance state, or null when the owner has not accepted the current version. */
  acceptance: DpaAcceptanceState | null;
  /** Called with the just-written state after a successful accept. */
  onAccepted: (state: DpaAcceptanceState) => void;
  /** Surface a transient error from the accept flow. */
  onError: (message: string) => void;
}

/**
 * Data processing agreement section — owner-only. Explains the GDPR Art. 28
 * DPA, links to the full text at `/dpa`, and renders either the accept control
 * or, once the owner has accepted the current version, the accepted state.
 *
 * The accept button is disabled while its action is in flight so a double
 * click cannot write a duplicate evidence row.
 *
 * @param props - Section configuration.
 * @returns Card with the DPA explanation and the accept or accepted state.
 */
export function DpaSection({
  organizationId,
  acceptance,
  onAccepted,
  onError,
}: DpaSectionProps) {
  const [pending, startTransition] = useTransition();

  const handleAccept = () => {
    startTransition(async () => {
      const result = await recordDpaAcceptanceAction({ organizationId });
      if (!result.ok) {
        onError(result.message);
        return;
      }
      onAccepted(result.data);
    });
  };

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Data processing agreement
      </p>
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm font-semibold text-text-primary">
          GDPR Article 28 data processing agreement
        </p>
        <p className="mt-1 text-xs text-text-muted">
          Because your team places personal data into Piyaz, we act as your data
          processor. Review the full{" "}
          <a
            href="/dpa"
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-secondary underline underline-offset-2 hover:text-text-primary"
          >
            data processing agreement
          </a>{" "}
          before accepting it on behalf of your team.
        </p>

        {acceptance ? (
          <p className="mt-4 text-xs text-text-secondary">
            Accepted version{" "}
            <span className="font-mono text-text-primary">
              {acceptance.version}
            </span>{" "}
            on {formatAbsolute(acceptance.acceptedAt)}.
          </p>
        ) : (
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={handleAccept}
              disabled={pending}
              isLoading={pending}
            >
              Accept agreement
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
