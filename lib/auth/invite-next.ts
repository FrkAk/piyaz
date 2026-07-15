/**
 * Validation for the `next` return-destination query param carried by the
 * invitation page's sign-in/sign-up CTAs. The only accepted shape is an
 * invitation detail path, which makes every accepted value same-origin by
 * construction: no scheme, no host, no protocol-relative `//`, no traversal,
 * no nested segments. Zero imports so the Edge middleware, server pages, and
 * client forms share one implementation.
 */

const INVITE_NEXT_RE = /^\/invitations\/[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a raw `next` query value against the invitation-path allowlist.
 *
 * @param raw - Untrusted query value, if any.
 * @returns The value when it is exactly an `/invitations/<id>` path, else `null`.
 */
export function safeInviteNext(raw: string | null | undefined): string | null {
  return typeof raw === "string" && INVITE_NEXT_RE.test(raw) ? raw : null;
}
