import "server-only";

import { headers } from "next/headers";
import { turnstileSiteKey } from "@/lib/config/env";

/** Props every captcha-protected auth form takes to render its widget. */
export interface TurnstileProps {
  turnstileSiteKey: string | null;
  nonce?: string;
}

/**
 * Resolve the Turnstile props for an auth page.
 *
 * The nonce comes from the `x-nonce` request header that `middleware.ts`
 * forwards on production renders, and is what lets Turnstile's injected script
 * survive the `'strict-dynamic'` CSP. Development sets no nonce (its CSP
 * allows inline script), so the field is simply absent there.
 *
 * @returns Site key (null when Turnstile is unconfigured) and CSP nonce.
 */
export async function turnstileProps(): Promise<TurnstileProps> {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return {
    turnstileSiteKey: turnstileSiteKey(),
    ...(nonce !== undefined && { nonce }),
  };
}
