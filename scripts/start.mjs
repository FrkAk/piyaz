// Self-host production entry. Never used by the Cloudflare target, which sets
// its own address policy from the edge header.
//
// The client-address policy is checked here rather than only on first use:
// `lib/auth.ts` loads lazily, so an unset variable would otherwise let the
// server report ready and then fail every auth request. Failing before the
// listener opens means the deploy breaks instead of the users' logins.
// Presence only; `addressPolicyError` in lib/security/client-ip.ts owns the
// full validation and reports a malformed value on first use.
if (!process.env.TRUSTED_PROXY_HEADER?.trim()) {
  console.error(
    'TRUSTED_PROXY_HEADER is required. Name the one request header your reverse proxy sets with the client address, or "none" if nothing fronts this deployment. See docs.piyaz.ai/docs/self-hosting.',
  );
  process.exit(1);
}

process.env.HOSTNAME = "127.0.0.1";
await import("../.next/standalone/server.js");
