"use client";

import { useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/shared/Button";
import { DpaConsentCheckbox } from "@/components/shared/DpaConsentCheckbox";
import { IconDoc } from "@/components/shared/icons";
import {
  canImportWorkspace,
  MAX_ORGANIZATION_ARCHIVE_BYTES,
  ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  readPortabilityError,
} from "@/lib/organization-portability/client";

interface ImportWorkspacePanelProps {
  /** Called when the user dismisses the import panel. */
  onCancel: () => void;
  /** Refresh the team list after the route creates an organization. */
  onImported: (
    organizationId: string,
  ) => boolean | void | Promise<boolean | void>;
}

/**
 * Format a selected archive's byte size for the package row.
 *
 * @param bytes - File size in bytes.
 * @returns Compact human-readable size.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Inline archive package selector and import form.
 *
 * @param props - Cancel and post-import refresh callbacks.
 * @returns Accent-tinted import panel.
 */
export function ImportWorkspacePanel({
  onCancel,
  onImported,
}: ImportWorkspacePanelProps) {
  const inputId = useId();
  const importingRef = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [dpaAccepted, setDpaAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startImport] = useTransition();
  const canSubmit = canImportWorkspace(file, dpaAccepted, pending);

  /**
   * Validate and retain one selected archive file.
   *
   * @param event - File input change event.
   * @returns Nothing.
   */
  const handleFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const selected = event.target.files?.[0] ?? null;
    setError(null);
    if (selected === null) {
      setFile(null);
      return;
    }
    if (!selected.name.toLowerCase().endsWith(".json")) {
      setFile(null);
      setError("Choose a JSON workspace archive.");
      event.target.value = "";
      return;
    }
    if (selected.size > MAX_ORGANIZATION_ARCHIVE_BYTES) {
      setFile(null);
      setError("The workspace archive must be 100 MiB or smaller.");
      event.target.value = "";
      return;
    }
    setFile(selected);
  };

  /**
   * Submit the selected raw archive once.
   *
   * @param event - Import form submission event.
   * @returns Nothing.
   */
  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit || file === null || importingRef.current) return;
    importingRef.current = true;
    setError(null);
    startImport(async () => {
      try {
        const response = await fetch("/api/organization/import", {
          method: "POST",
          headers: {
            "content-type": ORGANIZATION_ARCHIVE_MEDIA_TYPE,
            "x-piyaz-dpa-accepted": "true",
          },
          body: file,
        });
        if (!response.ok) {
          setError(await readPortabilityError(response));
          return;
        }
        const result = (await response.json()) as { organizationId?: unknown };
        if (typeof result.organizationId !== "string") {
          setError("The imported team response was incomplete. Try again.");
          return;
        }
        const refreshed = await onImported(result.organizationId);
        if (refreshed === false) {
          setError(
            "The workspace was imported, but the team list could not refresh. Reload the page to see it.",
          );
        }
      } catch {
        setError(
          "We couldn't import this workspace. Check your connection and try again.",
        );
      } finally {
        importingRef.current = false;
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-accent/25 bg-accent/5 p-5 shadow-[var(--shadow-card)]"
    >
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-light">
        Import workspace
      </p>
      <p className="mt-2 text-xs leading-relaxed text-text-muted">
        Create a new team from a Piyaz workspace archive. Projects, tasks,
        notes, links, and visible activity history keep their original dates.
      </p>

      <label
        htmlFor={inputId}
        className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border-strong bg-base/50 px-4 py-3 transition-colors hover:border-accent/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent"
      >
        <input
          id={inputId}
          type="file"
          accept=".json,application/json,application/vnd.piyaz.organization+json"
          onChange={handleFile}
          disabled={pending}
          className="sr-only"
        />
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised text-accent-light shadow-[var(--shadow-button)]">
          <IconDoc size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-text-primary">
            {file?.name ?? "Choose a workspace archive"}
          </span>
          <span className="mt-0.5 block font-mono text-[10px] text-text-muted">
            {file ? formatFileSize(file.size) : "JSON · up to 100 MiB"}
          </span>
        </span>
        <span className="text-[11px] font-medium text-text-secondary">
          {file ? "Replace" : "Browse"}
        </span>
      </label>

      <div className="mt-4">
        <DpaConsentCheckbox checked={dpaAccepted} onChange={setDpaAccepted} />
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-cancelled/25 bg-cancelled/10 px-3 py-2 text-xs text-cancelled"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          isLoading={pending}
        >
          Import workspace
        </Button>
      </div>
    </form>
  );
}
