import { addressPolicyError } from "@/lib/security/client-ip";

/**
 * Next.js instrumentation hook: refuse a production self-host boot without a
 * usable client-address policy.
 *
 * Covers every launch path that skips `scripts/start.mjs`, notably the Docker
 * image's direct `bun server.js`, turning "healthy but failing every auth
 * request" into a visible boot failure. The Cloudflare target loads this per
 * isolate on first request, where the policy comes from the edge header, so
 * it self-gates. The loader itself skips `NEXT_PHASE=phase-production-build`,
 * so building an image never requires the variable.
 *
 * @throws Error when the address policy is missing or malformed.
 */
export async function register(): Promise<void> {
  if (process.env.DEPLOY_TARGET === "cloudflare") return;
  if (process.env.NODE_ENV !== "production") return;
  const policyError = addressPolicyError();
  if (policyError) throw new Error(policyError);
}
