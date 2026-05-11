"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";
import { evaluateRedirect, safeLinkHost } from "@/lib/auth/safe-redirect";

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
};

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
      className="text-accent hover:underline"
    >
      {label} ({host})
    </a>
  );
}

/**
 * OAuth consent page — approve or deny an MCP client's access request.
 * Redirected here by the OAuth authorization endpoint with signed query
 * params. Requires an active session (BA's consent action is session-gated).
 *
 * Renders an identity-aware view: brand-normalized client name, the host of
 * the actual redirect_uri, a first-time / unsafe-redirect warning banner,
 * and the raw client_id demoted to a muted footnote.
 *
 * Trust model: `formatOAuthClientName` collapses brand-suffixed names
 * (e.g. `Claude Code (plugin:evil)` → `Claude Code`) for legibility, so
 * the consent header is NOT a trust statement about the client. The
 * `isFirstTime` warning is the only signal that fires on a never-seen
 * client; once the user approves, repeat visits no longer distinguish
 * spoofed clients from the originals visually. Long-term mitigation is
 * software statements (RFC 7591 §2.3) — tracked as MYMR-199.
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

  const missingClientId = !clientId;
  const metaError = missingClientId
    ? "Missing client_id in the authorization request."
    : fetchError;

  useEffect(() => {
    if (!clientId) return;
    const controller = new AbortController();
    fetch(
      `/api/oauth/consent-meta?client_id=${encodeURIComponent(clientId)}`,
      { signal: controller.signal },
    )
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
        const isHttp = /^https?:/i.test(res.data.url);
        window.location.href = res.data.url;
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
      <div className="flex min-h-[100dvh] items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-semibold text-text-primary">
            Authorization sent
          </h1>
          <p className="text-sm text-text-muted">
            Return to your application to finish signing in. You can close
            this tab.
          </p>
        </div>
      </div>
    );
  }

  if (missingClientId) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-semibold text-text-primary">
            Authorize access
          </h1>
          <div
            className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
            role="alert"
          >
            {metaError}
          </div>
          <p className="text-sm text-text-muted">You can close this tab.</p>
        </div>
      </div>
    );
  }

  const brandName = meta ? formatOAuthClientName(meta.client_name) : "";
  const initial = brandName.charAt(0).toUpperCase() || "?";

  const warnings: string[] = [];
  if (meta) {
    if (!meta.logo_uri || !meta.client_uri) {
      warnings.push("This app has not published a website or logo.");
    }
    if (meta.isFirstTime) {
      warnings.push("This is the first time you are approving this app.");
    }
  }
  if (!redirect.safe) {
    warnings.push(`Redirecting to an unverified destination: ${redirect.display}.`);
  }

  const approveDisabled = submitting || !meta;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <div
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-base font-semibold text-accent"
          >
            {initial}
          </div>
          <div className="space-y-1 text-center">
            <h1 className="text-xl font-semibold text-text-primary">
              {meta ? brandName : metaError ? "Authorize access" : "…"}
            </h1>
            <p className="text-sm text-text-muted">
              wants to access your Mymir account.
            </p>
          </div>
        </div>

        {metaError && (
          <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger" role="alert">
            {metaError}
          </div>
        )}

        <div className="space-y-3">
          <div className="rounded-md border border-border-strong bg-surface p-3">
            <p className="text-xs font-medium text-text-secondary">
              Redirecting to
            </p>
            <p className="text-sm font-mono text-text-primary break-all">
              {redirect.display}
            </p>
          </div>

          {meta && (meta.client_uri || meta.tos_uri || meta.policy_uri) && (
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
            <div className="rounded-md border border-border-strong bg-surface p-3 space-y-2">
              <p className="text-xs font-medium text-text-secondary">
                Requested permissions
              </p>
              <ul className="space-y-1">
                {scopes.map((s) => (
                  <li
                    key={s}
                    className="text-sm text-text-primary flex items-center gap-2"
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
              className="rounded-md border border-progress/25 bg-progress/10 p-3 text-xs text-progress space-y-1"
              role="alert"
            >
              {warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
              <p className="text-text-muted">
                Verify it is the one you started signing into.
              </p>
            </div>
          )}

          {error && (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              disabled={submitting}
              onClick={() => handleConsent(false)}
              className="flex-1 rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-text-primary transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Deny
            </button>
            <button
              type="button"
              disabled={approveDisabled}
              onClick={() => handleConsent(true)}
              className="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-1">
                  <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                  <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                  <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                </span>
              ) : (
                "Approve"
              )}
            </button>
          </div>

          {clientId && (
            <p className="text-center text-[10px] font-mono text-text-muted break-all">
              client_id: {clientId}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
