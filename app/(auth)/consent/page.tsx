"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";
import {
  evaluateRedirect,
  isNavigableRedirectUrl,
  safeLinkHost,
} from "@/lib/auth/safe-redirect";
import { Avatar } from "@/components/shared/Avatar";
import { Button } from "@/components/shared/Button";
import { MonoId } from "@/components/shared/MonoId";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";

/**
 * Hydration-safe deployment-host snapshot for `useSyncExternalStore`.
 *
 * The redirect-safety check needs `window.location.host` to recognize a
 * same-host redirect_uri, but referencing `window` during SSR throws. We
 * solve it the canonical React 18+ way: the server snapshot returns
 * `null` (fail-closed → redirect renders as unverified), and the client
 * snapshot fills in the real host after hydration. No subscription is
 * needed because the deployment host doesn't change during the page's
 * lifetime — `subscribeNoop` satisfies the API without doing work.
 *
 * Note: this produces a brief content shift on first paint where a
 * same-host redirect_uri flips from "unverified" to "verified" once
 * hydration runs. That's the correct fail-closed trade-off.
 */
function subscribeNoop(): () => void {
  return () => {};
}
function getOwnHostClient(): string | null {
  return typeof window === "undefined" ? null : window.location.host;
}
function getOwnHostServer(): string | null {
  return null;
}

type ConsentMeta = {
  client_id: string;
  client_name: string;
  client_uri?: string;
  logo_uri?: string;
  tos_uri?: string;
  policy_uri?: string;
  isFirstTime: boolean;
  verified: boolean;
};

/** Shared utility classes for the in-card section header — mirrors the
 *  workspace detail convention (see `RelationshipsSection.tsx`). */
const SECTION_LABEL =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted";

/**
 * One DCR metadata link rendered with its destination host appended.
 *
 * The href is attacker-controlled (anyone can DCR a client with any
 * `client_uri` / `tos_uri` / `policy_uri`), so the user must see the
 * destination host before clicking. Unparseable or non-http(s) URLs
 * render nothing — fail-closed against `javascript:` / `data:` smuggling.
 *
 * @param label - Visible link label (Website / Terms / Privacy).
 * @param href - Raw URL from the DCR metadata field.
 */
function MetadataLink({
  label,
  href,
}: {
  label: string;
  href: string;
}): React.ReactNode {
  const host = safeLinkHost(href);
  if (!host) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-sm text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-0"
    >
      {label} ({host})
    </a>
  );
}

/** Centered single-message panel used for the missing-clientId and
 *  fetch-error branches. Keeps the destructive Approve action off the
 *  screen when there's nothing legitimate to approve. */
function ConsentErrorPanel({ message }: { message: string }): React.ReactNode {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1
          className="text-[22px] font-semibold text-text-primary"
          style={{ letterSpacing: "-0.005em", lineHeight: 1.2 }}
        >
          Authorize access
        </h1>
        <div
          className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
          role="alert"
        >
          {message}
        </div>
        <p className="text-sm text-text-muted">You can close this tab.</p>
      </div>
    </div>
  );
}

/**
 * OAuth consent page — approve or deny an MCP client's access request.
 * Redirected here by the OAuth authorization endpoint with signed query
 * params. Requires an active session (BA's consent action is session-gated).
 *
 * Renders an identity-aware view: brand-normalized client name, the host of
 * the actual redirect_uri, a first-time / unsafe-redirect warning banner,
 * and the raw client_id demoted to a copyable mono footnote.
 *
 * Trust model: dynamic client registration is open, so the `client_name`
 * is attacker-chosen. Brand polish (collapsing `Claude Code (plugin:evil)`
 * → `Claude Code`) is therefore gated on `meta.verified` — true only for
 * client_ids on the server-side allowlist (`isVerifiedOAuthClient`). For an
 * unverified client the raw registered name is shown verbatim (React-escaped)
 * so a spoofed name cannot impersonate a trusted brand. The `isFirstTime`
 * and unverified-redirect warnings remain the per-request trust signals.
 * Software statements (RFC 7591 §2.3) are the longer-term hardening — MYMR-199.
 *
 * `logo_uri` is intentionally NOT rendered. Displaying an
 * attacker-controlled image is a separate UX upgrade requiring
 * `referrerPolicy="no-referrer"` + a CSP `img-src` review + layout-shift
 * safety; until that lands, the avatar shows the brand initial.
 *
 * @returns Consent form with approve/deny buttons.
 */
export default function ConsentPage() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id");
  const redirectUri = searchParams.get("redirect_uri");
  const scope = searchParams.get("scope");

  const [meta, setMeta] = useState<ConsentMeta | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    const controller = new AbortController();
    fetch(`/api/oauth/consent-meta?client_id=${encodeURIComponent(clientId)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          setFetchError(
            res.status === 404
              ? "This application is no longer registered."
              : "Could not load application details.",
          );
          return;
        }
        setMeta((await res.json()) as ConsentMeta);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setFetchError("Could not load application details.");
      });
    return () => controller.abort();
  }, [clientId]);

  const ownHost = useSyncExternalStore(
    subscribeNoop,
    getOwnHostClient,
    getOwnHostServer,
  );

  const redirect = useMemo(
    () => evaluateRedirect(redirectUri, ownHost),
    [redirectUri, ownHost],
  );

  /**
   * Submit consent decision to the OAuth provider.
   *
   * @param accept - Whether the user approved access.
   */
  async function handleConsent(accept: boolean) {
    setError("");
    setSubmitting(true);

    try {
      const res = await authClient.oauth2.consent({
        accept,
        oauth_query: window.location.search.slice(1),
      });

      if (res.data?.url) {
        const url = res.data.url;
        if (!isNavigableRedirectUrl(url)) {
          setError("Refusing to redirect to an unsupported destination.");
          setSubmitting(false);
          return;
        }
        const isHttp = /^https?:/i.test(url);
        window.location.href = url;
        if (!isHttp) {
          setDone(true);
          setSubmitting(false);
        }
        return;
      }

      if (res.error) {
        setError(res.error.message ?? "Consent failed");
        setSubmitting(false);
      }
    } catch {
      setError("Something went wrong");
      setSubmitting(false);
    }
  }

  const scopes = scope?.split(" ").filter(Boolean) ?? [];

  if (done) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1
            className="text-[22px] font-semibold text-text-primary"
            style={{ letterSpacing: "-0.005em", lineHeight: 1.2 }}
          >
            Authorization sent
          </h1>
          <p className="text-sm text-text-muted">
            Return to your application to finish signing in. You can close this
            tab.
          </p>
        </div>
      </div>
    );
  }

  if (!clientId) {
    return (
      <ConsentErrorPanel message="Missing client_id in the authorization request." />
    );
  }

  if (fetchError) {
    return <ConsentErrorPanel message={fetchError} />;
  }

  if (!meta) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <LoadingSpinner label="Loading application details" />
      </div>
    );
  }

  const brandName = formatOAuthClientName(meta.client_name, meta.verified);

  const warnings: string[] = [];
  if (!meta.client_uri) {
    warnings.push("This app has not published a website.");
  }
  if (meta.isFirstTime) {
    warnings.push("This is the first time you are approving this app.");
  }
  if (!redirect.safe) {
    warnings.push(
      `Redirecting to an unverified destination: ${redirect.display}.`,
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Avatar name={brandName} size={56} />
          <div className="space-y-1 text-center">
            <h1
              className="text-[22px] font-semibold text-text-primary"
              style={{ letterSpacing: "-0.005em", lineHeight: 1.2 }}
            >
              {brandName}
            </h1>
            <p className="text-sm text-text-muted">
              wants to access your piyaz account.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-border-strong bg-surface p-3">
            <p className={SECTION_LABEL}>Redirecting to</p>
            <p className="mt-1.5 break-all font-mono text-sm text-text-primary">
              {redirect.display}
            </p>
          </div>

          {(meta.client_uri || meta.tos_uri || meta.policy_uri) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs">
              {meta.client_uri && (
                <MetadataLink label="Website" href={meta.client_uri} />
              )}
              {meta.tos_uri && (
                <MetadataLink label="Terms" href={meta.tos_uri} />
              )}
              {meta.policy_uri && (
                <MetadataLink label="Privacy" href={meta.policy_uri} />
              )}
            </div>
          )}

          {scopes.length > 0 && (
            <div className="space-y-2 rounded-lg border border-border-strong bg-surface p-3">
              <p className={SECTION_LABEL}>Requested permissions</p>
              <ul className="space-y-1">
                {scopes.map((s) => (
                  <li
                    key={s}
                    className="flex items-center gap-2 text-sm text-text-primary"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div
              className="space-y-1 rounded-lg border border-progress/25 bg-progress/10 p-3 text-xs text-progress"
              role="alert"
            >
              {warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
              <p className="text-text-muted">
                Confirm this matches where you started.
              </p>
            </div>
          )}

          {error && (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              disabled={submitting}
              onClick={() => handleConsent(false)}
            >
              Deny
            </Button>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              isLoading={submitting}
              onClick={() => handleConsent(true)}
            >
              Approve
            </Button>
          </div>

          <div className="flex justify-center pt-1">
            <MonoId id={clientId} />
          </div>
        </div>
      </div>
    </div>
  );
}
