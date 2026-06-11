"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import {
  listOAuthSessionsAction,
  revokeAllOAuthSessionsAction,
  type OAuthSessionView,
} from "@/lib/actions/oauth-session";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";
import { AgentSection } from "./AgentSection";
import { InlineConfirm } from "./InlineConfirm";

interface AgentsTabProps {
  /** Initial session list, hydrated from the server component. */
  initialSessions: OAuthSessionView[];
}

/** Canonical brands rendered as fixed sections, in display order. */
const KNOWN_BRANDS = ["Claude Code", "Codex", "Antigravity", "Cursor"] as const;
type KnownBrand = (typeof KNOWN_BRANDS)[number];
const KNOWN_BRAND_SET: ReadonlySet<string> = new Set(KNOWN_BRANDS);

/**
 * Group sessions into the four canonical brand buckets plus a catch-all
 * "Other" bucket for clients that don't match a known brand.
 *
 * @param sessions - Raw session list from the server action.
 * @returns Object with `byBrand` (brand → sessions) and `otherSessions`.
 */
function groupSessions(sessions: OAuthSessionView[]): {
  byBrand: Record<KnownBrand, OAuthSessionView[]>;
  otherSessions: OAuthSessionView[];
} {
  const byBrand: Record<KnownBrand, OAuthSessionView[]> = {
    "Claude Code": [],
    Codex: [],
    Antigravity: [],
    Cursor: [],
  };
  const otherSessions: OAuthSessionView[] = [];

  for (const session of sessions) {
    const brand = formatOAuthClientName(session.clientName, session.verified);
    if (KNOWN_BRAND_SET.has(brand)) {
      byBrand[brand as KnownBrand].push(session);
    } else {
      otherSessions.push(session);
    }
  }

  return { byBrand, otherSessions };
}

/**
 * Agents & devices tab — H1 + subhead + four fixed brand cards (Claude Code,
 * Codex, Antigravity, Cursor) plus a catch-all card when non-canonical clients
 * have authorized sessions. Optimistically removes a row on revoke and
 * surfaces an inline error if the server rejects.
 *
 * @param props - Initial server-rendered session list.
 * @returns Tab body.
 */
export function AgentsTab({ initialSessions }: AgentsTabProps) {
  const [sessions, setSessions] = useState<OAuthSessionView[]>(initialSessions);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleRevoked = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleError = useCallback((message: string) => {
    setError(message);
  }, []);

  const handleRefresh = () => {
    setError(null);
    startTransition(async () => {
      const result = await listOAuthSessionsAction();
      if (result.ok) {
        setSessions(result.data);
      } else {
        setError(result.message);
      }
    });
  };

  const handleRevokeAll = async () => {
    setError(null);
    const result = await revokeAllOAuthSessionsAction();
    if (result.ok) {
      setSessions([]);
    } else {
      setError(result.message);
    }
  };

  const { byBrand, otherSessions } = useMemo(
    () => groupSessions(sessions),
    [sessions],
  );

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight text-text-primary">
            Agents &amp; devices
          </h1>
          <p className="mt-1 text-[13px] text-text-muted">
            Sessions authorized to run via MCP. Changing your password revokes
            every session automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={pending}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
          aria-label="Refresh sessions"
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`}
          >
            <path d="M8 3V1.5a.5.5 0 01.85-.36l2.5 2.5a.5.5 0 010 .72l-2.5 2.5A.5.5 0 018 6.5V5a3 3 0 100 6 .75.75 0 010 1.5A4.5 4.5 0 118 3z" />
          </svg>
          Refresh
        </button>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-cancelled/25 bg-cancelled/10 px-3 py-2 text-[12px] text-cancelled"
        >
          {error}
        </div>
      ) : null}

      <div className="space-y-3">
        {sessions.length > 0 ? (
          <div className="flex min-h-9 items-center justify-end">
            <InlineConfirm
              trigger={
                <button
                  type="button"
                  className="cursor-pointer rounded-md px-2.5 py-1 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  Revoke all
                </button>
              }
              prompt="Revoke all sessions?"
              body="Every connected agent will need to re-authorize."
              confirmLabel="Revoke all"
              destructive
              onConfirm={handleRevokeAll}
            />
          </div>
        ) : null}
        {KNOWN_BRANDS.map((brand) => (
          <AgentSection
            key={brand}
            brand={brand}
            sessions={byBrand[brand]}
            onRevoked={handleRevoked}
            onError={handleError}
          />
        ))}
        {otherSessions.length > 0 ? (
          <AgentSection
            brand="Other"
            sessions={otherSessions}
            emptyBody="No sessions."
            onRevoked={handleRevoked}
            onError={handleError}
          />
        ) : null}
      </div>
    </section>
  );
}
