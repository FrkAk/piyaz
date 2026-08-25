"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/shared/Button";
import { IconCheck, IconDoc } from "@/components/shared/icons";
import {
  organizationArchiveFilename,
  readPortabilityError,
} from "@/lib/organization-portability/client";

interface WorkspaceExportSectionProps {
  /** Organization UUID named by the export route. */
  teamId: string;
  /** Current organization slug used for the local filename. */
  teamSlug: string;
  /** Surface or clear a modal-level export error. */
  onError: (message: string | null) => void;
}

/**
 * Owner-only workspace archive download section.
 *
 * @param props - Team identity and modal error callback.
 * @returns Portable workspace card with a guarded download action.
 */
export function WorkspaceExportSection({
  teamId,
  teamSlug,
  onError,
}: WorkspaceExportSectionProps) {
  const exportingRef = useRef(false);
  const [exporting, startExport] = useTransition();
  const [downloaded, setDownloaded] = useState(false);

  /**
   * Start one archive download and ignore duplicate clicks.
   *
   * @returns Nothing.
   */
  const handleExport = (): void => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setDownloaded(false);
    onError(null);
    startExport(async () => {
      try {
        const response = await fetch(
          `/api/organization/${encodeURIComponent(teamId)}/export`,
        );
        if (!response.ok) {
          onError(await readPortabilityError(response));
          return;
        }
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = organizationArchiveFilename(teamSlug);
        document.body.append(anchor);
        anchor.click();
        setDownloaded(true);
        // The download navigation is queued, not synchronous (Firefox,
        // Safari): revoking in the same task kills the blob URL before the
        // browser resolves it and the download silently produces nothing.
        window.setTimeout(() => {
          anchor.remove();
          URL.revokeObjectURL(url);
        }, 1000);
      } catch {
        onError(
          "We couldn't download this workspace. Check your connection and try again.",
        );
      } finally {
        exportingRef.current = false;
      }
    });
  };

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Workspace archive
      </p>
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-accent/20 bg-accent/5 text-accent-light">
                <IconDoc size={13} />
              </span>
              <p className="text-sm font-semibold text-text-primary">
                Export workspace
              </p>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              Download projects, tasks, dependencies, notes, and visible
              activity history as one JSON archive. Member accounts and their
              private notes are not included.
            </p>
            <p
              role="status"
              className={`mt-3 inline-flex max-w-full items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-[11px] transition-colors ${
                downloaded
                  ? "border-done/25 bg-done/10 text-done"
                  : "border-border bg-base text-text-secondary"
              }`}
            >
              {downloaded ? <IconCheck size={11} /> : <IconDoc size={11} />}
              <span className="truncate">
                {organizationArchiveFilename(teamSlug)}
              </span>
              {downloaded ? (
                <span className="shrink-0">· saved to downloads</span>
              ) : null}
            </p>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={handleExport}
            disabled={exporting}
            isLoading={exporting}
          >
            Download archive
          </Button>
        </div>
      </div>
    </section>
  );
}
