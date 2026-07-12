"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/shared/Button";
import { DpaConsentCheckbox } from "@/components/shared/DpaConsentCheckbox";
import { createTeamAction } from "@/lib/actions/team";
import { deriveTeamSlug } from "@/lib/team/derive-slug";
import { TEAM_NAME_MAX } from "@/lib/team/slug-rules";

const INPUT_CLASS =
  "w-full rounded-lg border border-border-strong bg-base px-4 py-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent";

interface CreateTeamPanelProps {
  /** Called when the user dismisses the panel without creating a team. */
  onCancel: () => void;
  /** Called after a successful create with the new team's id. */
  onCreated: (organizationId: string) => void;
  /** Caller's display name — first word becomes "{name}'s Team" placeholder. */
  userName?: string | null;
}

/** Personalize the placeholder using the caller's first name. */
function teamNamePlaceholder(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${first}'s Team` : "My Team";
}

/**
 * Inline panel for creating a new team. Slug is derived from the name
 * client-side; the server is the source of truth and will reject
 * collisions / reserved values.
 *
 * @param props - Panel callbacks.
 * @returns Accent-tinted form rendered above the team list.
 */
export function CreateTeamPanel({
  onCancel,
  onCreated,
  userName,
}: CreateTeamPanelProps) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dpaAccepted, setDpaAccepted] = useState(false);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && dpaAccepted && !pending;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    const slug = deriveTeamSlug(trimmed);
    startTransition(async () => {
      try {
        const result = await createTeamAction({
          name: trimmed,
          slug,
          dpaAccepted,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onCreated(result.data.organizationId);
      } catch {
        setError(
          "Something went wrong reaching the server. Check your connection and try again.",
        );
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-accent/25 bg-accent/5 p-5 shadow-[var(--shadow-card)]"
    >
      <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-light">
        New team
      </p>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-text-secondary">
          Team name
        </span>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={TEAM_NAME_MAX}
          placeholder={teamNamePlaceholder(userName)}
          className={INPUT_CLASS}
        />
      </label>
      <div className="mt-3">
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
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          isLoading={pending}
        >
          Create team
        </Button>
      </div>
    </form>
  );
}
