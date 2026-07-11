/**
 * Turns `process.env` into a typed `BrandConfig` and picks the correct
 * `from`/`replyTo` for each email purpose. This is the single place addressing
 * and brand presentation are resolved; templates and transport wiring read the
 * `BrandConfig` and call `senderFor` rather than hardcoding addresses.
 *
 * Config-gated by design: cloud sets the brand and address env vars and gets
 * branded, human-reachable mail; self-host leaves them unset and gets neutral,
 * logo-less output from the operator's own domain. No var ever defaults to a
 * `@piyaz.ai` address or the `Piyaz` name, so a self-host `From` stays on a
 * domain the operator controls and can SPF/DKIM-authenticate, and self-host
 * cannot emit Piyaz-branded mail. Pure `process.env` reads: no imports beyond
 * the shared type and the template sanitizers, no side effects, compiles
 * identically into both bundles.
 */
import {
  FOOTER_SCHEMES,
  LOGO_SCHEMES,
  safeBrandColor,
  safeUrl,
} from "./templates/render";
import type { BrandConfig } from "./types";

/**
 * Read a brand/address env var, trimmed, treating unset or blank as absent so
 * an operator who leaves a var empty gets the neutral path rather than a blank
 * address. Mirrors the empty-as-absent fail-safe of `parseEnvInt`.
 */
function brandString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Hostname of `appUrl`, or `undefined` when the URL is unparsable or hostless,
 * so `appUrl` and `appName` degrade from the same validity check and a
 * malformed `BETTER_AUTH_URL` cannot crash address resolution.
 */
function hostOf(appUrl: string): string | undefined {
  try {
    const host = new URL(appUrl).hostname;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * Parse `BRAND_FOOTER_LINKS` as a JSON array of `{ label, url }`. Entries are
 * remapped to trimmed `label`/`url` only (unknown JSON fields never reach the
 * `BrandConfig`) and dropped when blank or when `url` is not https/mailto. Returns
 * `undefined` for unset, malformed, non-array, or empty-after-filtering input;
 * never throws, so a bad value yields a neutral footer instead of a crash.
 */
function parseFooterLinks(raw: string | undefined): BrandConfig["footerLinks"] {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const links = parsed
    .filter(
      (entry): entry is { label: string; url: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { label?: unknown }).label === "string" &&
        (entry as { label: string }).label.trim() !== "" &&
        typeof (entry as { url?: unknown }).url === "string" &&
        (entry as { url: string }).url.trim() !== "",
    )
    .map((entry) => ({ label: entry.label.trim(), url: entry.url.trim() }))
    .filter((entry) => safeUrl(entry.url, FOOTER_SCHEMES) !== undefined);
  return links.length > 0 ? links : undefined;
}

/**
 * Resolve the deployment's `BrandConfig` from env. `appUrl` comes from
 * `BETTER_AUTH_URL`, else `http://localhost:3000` when unset or unparsable, so
 * a malformed value never reaches template hrefs. `appName` comes from
 * `APP_NAME`, else the `appUrl` host (never `Piyaz`). The presentation fields
 * (`logoUrl` from `BRAND_LOGO_URL`, https only; `brandColor` from
 * `BRAND_COLOR`, 3- or 6-digit hex only; `footerLinks` from
 * `BRAND_FOOTER_LINKS`; `supportEmail` from `EMAIL_REPLY_TO`) default to
 * `undefined` when their var is unset or malformed, keeping the unconfigured
 * render neutral.
 */
export function resolveBrandConfig(): BrandConfig {
  const configuredUrl = brandString("BETTER_AUTH_URL");
  const appUrl =
    configuredUrl !== undefined && hostOf(configuredUrl) !== undefined
      ? configuredUrl
      : "http://localhost:3000";
  const appName = brandString("APP_NAME") ?? hostOf(appUrl) ?? "localhost";
  const logoUrl = brandString("BRAND_LOGO_URL");
  const brandColor = brandString("BRAND_COLOR");
  return {
    appName,
    appUrl,
    logoUrl: logoUrl === undefined ? undefined : safeUrl(logoUrl, LOGO_SCHEMES),
    brandColor:
      brandColor === undefined ? undefined : safeBrandColor(brandColor),
    footerLinks: parseFooterLinks(brandString("BRAND_FOOTER_LINKS")),
    supportEmail: brandString("EMAIL_REPLY_TO"),
  };
}

/**
 * The intent of an email, which drives sender identity and whether a reply is
 * invited. `transactional` is no-reply system mail (verification, password
 * reset, email-change, security notices); `personal` is human-reachable mail
 * that always invites a reply (team invites, welcome); `informational` is
 * no-reply informational mail.
 */
export type EmailPurpose = "transactional" | "personal" | "informational";

/**
 * Select the `from` (and, for `personal` mail, `replyTo`) for an email purpose.
 *
 * `from` resolves per-purpose then falls back to the single configured
 * `EMAIL_FROM`, then to `noreply@<appUrl host>` so the resolver is total and
 * non-throwing even fully unconfigured, never emitting `@piyaz.ai`.
 * - `transactional`: `EMAIL_FROM_NOREPLY`, no `replyTo`.
 * - `personal`: `EMAIL_FROM_SUPPORT`, `replyTo` = `EMAIL_REPLY_TO` else the
 *   resolved `from` (a `replyTo` is always present).
 * - `informational`: `EMAIL_FROM_INFO`, no `replyTo`.
 */
export function senderFor(purpose: EmailPurpose): {
  from: string;
  replyTo?: string;
} {
  const brand = resolveBrandConfig();
  const fallbackFrom =
    brandString("EMAIL_FROM") ??
    `noreply@${hostOf(brand.appUrl) ?? "localhost"}`;

  switch (purpose) {
    case "transactional":
      return { from: brandString("EMAIL_FROM_NOREPLY") ?? fallbackFrom };
    case "personal": {
      const from = brandString("EMAIL_FROM_SUPPORT") ?? fallbackFrom;
      return { from, replyTo: brand.supportEmail ?? from };
    }
    case "informational":
      return { from: brandString("EMAIL_FROM_INFO") ?? fallbackFrom };
    default:
      return { from: fallbackFrom };
  }
}
