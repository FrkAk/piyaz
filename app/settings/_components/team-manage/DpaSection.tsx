"use client";

import { useTransition } from "react";
import { Button } from "@/components/shared/Button";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { formatAbsolute } from "@/lib/ui/relative-time";
import {
  recordDpaAcceptanceAction,
  type DpaAcceptanceState,
} from "@/lib/actions/legal";

interface DpaSectionProps {
  /** Team UUID — the explicit org the owner accepts the DPA for. */
  organizationId: string;
  /** Latest acceptance regardless of version, or null when never accepted. */
  acceptance: DpaAcceptanceState | null;
  /** Called with the just-written state after a successful accept. */
  onAccepted: (state: DpaAcceptanceState) => void;
  /** Surface a transient error from the accept flow. */
  onError: (message: string) => void;
}

/**
 * Data processing agreement section — owner-only. Explains the GDPR Art. 28
 * DPA, links to the full text at `/dpa`, and renders one of three states:
 * accepted at the current version, an update notice with the re-accept
 * control when the accepted version is stale (a `LEGAL_VERSIONS.dpa` bump is
 * notice-only and never blocks access), or the first-accept control.
 *
 * The accept button is disabled while its action is in flight so a double
 * click cannot write a duplicate evidence row.
 *
 * @param props - Section configuration.
 * @returns Card with the DPA explanation and the state-appropriate control.
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

        {acceptance && acceptance.version === LEGAL_VERSIONS.dpa ? (
          <p className="mt-4 text-xs text-text-secondary">
            Accepted version{" "}
            <span className="font-mono text-text-primary">
              {acceptance.version}
            </span>{" "}
            on {formatAbsolute(acceptance.acceptedAt)}.
          </p>
        ) : acceptance ? (
          <>
            <p
              className="mt-4 rounded-md border border-progress/25 bg-progress/10 px-3 py-2 text-xs text-progress"
              role="status"
            >
              The data processing agreement was updated. Your team accepted
              version <span className="font-mono">{acceptance.version}</span> on{" "}
              {formatAbsolute(acceptance.acceptedAt)}; continued use is covered
              by the update terms, and you can accept the current version now.
            </p>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={handleAccept}
                disabled={pending}
                isLoading={pending}
              >
                Accept updated agreement
              </Button>
            </div>
          </>
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
