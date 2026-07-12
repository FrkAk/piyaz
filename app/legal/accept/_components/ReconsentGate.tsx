"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DeleteAccountDialog } from "@/app/settings/_components/DeleteAccountDialog";
import { Button } from "@/components/shared/Button";
import { Markdown } from "@/components/shared/Markdown";
import { acceptUpdatedLegalAction } from "@/lib/actions/legal";
import { exportAccountDataAction } from "@/lib/actions/profile";
import { signOut } from "@/lib/auth-client";
import type { ReconsentDocumentType } from "@/lib/data/legal";

/** One outstanding document rendered by the gate. */
export type ReconsentDoc = {
  /** Document type, keyed to `LEGAL_VERSIONS`. */
  type: ReconsentDocumentType;
  /** Display title. */
  title: string;
  /** Public page for the full document. */
  href: string;
  /** Bundled Markdown body. */
  body: string;
};

interface ReconsentGateProps {
  /** Outstanding documents, in display order. */
  docs: ReconsentDoc[];
  /** Signed-in user's email, for the delete-account confirmation. */
  email: string;
}

/**
 * Client half of the re-acceptance interstitial. Renders each outstanding
 * document in a scrollable card, one affirmative accept action, and an
 * equally reachable decline row (sign out, export data, delete account) so
 * declining users can leave with their data instead of being funneled into
 * accepting. The accept action derives the outstanding set server-side;
 * nothing here is trusted.
 *
 * @param props - Outstanding docs and the caller's email.
 * @returns Full-page gate UI.
 */
export function ReconsentGate({ docs, email }: ReconsentGateProps) {
  const router = useRouter();
  const [accepting, startAccept] = useTransition();
  const [exporting, startExport] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  /** Record acceptance of every outstanding document, then leave the gate. */
  const handleAccept = () => {
    setError(null);
    startAccept(async () => {
      const result = await acceptUpdatedLegalAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.replace("/");
      router.refresh();
    });
  };

  /** Download the caller's account data as a JSON file. */
  const handleExport = () => {
    setError(null);
    startExport(async () => {
      const result = await exportAccountDataAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const blob = new Blob([JSON.stringify(result.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "piyaz-account-export.json";
      anchor.click();
      URL.revokeObjectURL(url);
    });
  };

  /** End the session and return to sign-in without accepting. */
  const handleSignOut = async () => {
    await signOut();
    router.replace("/sign-in");
  };

  const docTitles = docs.map((doc) => doc.title).join(" and ");

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl space-y-6">
        <div>
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Updated legal documents
          </span>
          <h1
            className="mt-2 text-[22px] font-semibold text-text-primary"
            style={{ letterSpacing: "-0.005em", lineHeight: 1.2 }}
          >
            Review and accept to continue
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-text-muted">
            Piyaz updated the {docTitles}. Accept the current{" "}
            {docs.length > 1 ? "versions" : "version"} to keep using the app,
            API, and MCP.
          </p>
        </div>

        {docs.map((doc) => (
          <section
            key={doc.type}
            className="rounded-lg border border-border-strong bg-surface"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-[13px] font-semibold text-text-primary">
                {doc.title}
              </span>
              <a
                href={doc.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-accent hover:underline"
              >
                Open full page
              </a>
            </div>
            <div className="legal-doc max-h-56 overflow-y-auto px-4 py-3">
              <Markdown>{doc.body}</Markdown>
            </div>
          </section>
        ))}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          isLoading={accepting}
          onClick={handleAccept}
        >
          Accept and continue
        </Button>

        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12.5px] text-text-muted">
          <button
            type="button"
            onClick={handleSignOut}
            className="hover:text-text-primary hover:underline"
          >
            Sign out instead
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="hover:text-text-primary hover:underline disabled:opacity-60"
          >
            {exporting ? "Exporting…" : "Export my data"}
          </button>
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="hover:text-text-primary hover:underline"
          >
            Delete my account
          </button>
        </div>
      </div>

      <DeleteAccountDialog
        open={deleteOpen}
        email={email}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}
