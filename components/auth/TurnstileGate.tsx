"use client";

import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Handle the parent form uses to clear a spent token after a failed submit. */
export interface TurnstileHandle {
  /** Discard the current token and re-run the challenge. */
  reset: () => void;
}

/** Message shown when a submit lands before the challenge has produced a token. */
export const TURNSTILE_PENDING_MESSAGE =
  "Complete the verification to continue.";

/**
 * Token plumbing shared by every captcha-protected auth form.
 *
 * Collapses the four-line dance each form would otherwise repeat: hold the
 * token, expose a reset handle to clear a spent one, and shape the token into
 * the `fetchOptions` Better Auth forwards as request headers.
 *
 * @param siteKey - Public site key, or `null` when Turnstile is unconfigured.
 * @returns Widget props, the current token, a `reset`, and a `fetchOptions`
 *   builder that yields `undefined` when Turnstile is off.
 */
export function useTurnstile(siteKey: string | null) {
  const [token, setToken] = useState<string | null>(null);
  const handleRef = useRef<TurnstileHandle | null>(null);

  const reset = useCallback(() => handleRef.current?.reset(), []);

  /**
   * Whether a submit may proceed. Always true when Turnstile is off, so the
   * unconfigured deployment keeps its original behavior.
   */
  const ready = siteKey === null || token !== null;

  /**
   * Header carrier for a Better Auth client call. Better Auth reads the token
   * from `x-captcha-response`; there is no client plugin that injects it.
   */
  const fetchOptions =
    token !== null ? { headers: { "x-captcha-response": token } } : undefined;

  return { token, setToken, handleRef, reset, ready, fetchOptions };
}

interface TurnstileGateProps {
  /** Public site key; `null` disables the widget entirely (self-host). */
  siteKey: string | null;
  /** Per-request CSP nonce, forwarded to Turnstile's injected script. */
  nonce?: string;
  /** Receives the token once the challenge resolves, `null` when it clears. */
  onToken: (token: string | null) => void;
  /** Imperative handle for reset-on-error. */
  handleRef?: RefObject<TurnstileHandle | null>;
}

/**
 * Cloudflare Turnstile widget for the auth forms.
 *
 * Renders nothing when `siteKey` is null, so a deployment without Turnstile
 * (self-host) keeps the forms exactly as they were.
 *
 * Configured `appearance="interaction-only"`: the challenge runs in the
 * background from page load and stays invisible for ordinary visitors, and
 * only materializes when Cloudflare's managed mode decides an interaction is
 * warranted. The wrapper reserves no height while hidden but the parent form
 * keeps the slot in flow, so an escalation does not shove the submit button
 * out from under the pointer.
 *
 * The nonce matters: production CSP is `'strict-dynamic'` with a per-request
 * nonce, and Turnstile propagates the nonce it is given to the resources it
 * injects. Without it the widget's own scripts are blocked.
 *
 * `action` is Cloudflare's Spin attribution marker, analytics-only: the
 * server does not configure `expectedAction`, so verification never keys on
 * it.
 *
 * @param props - Site key, CSP nonce, token callback, and reset handle.
 * @returns The widget, or null when Turnstile is not configured.
 */
export function TurnstileGate({
  siteKey,
  nonce,
  onToken,
  handleRef,
}: TurnstileGateProps) {
  const widget = useRef<TurnstileInstance | null>(null);

  useImperativeHandle(handleRef, () => ({
    reset: () => {
      // Tokens are single-use with a 300s TTL, so a spent token left in the
      // widget turns one failed submit into a permanently failing form.
      widget.current?.reset();
      onToken(null);
    },
  }));

  if (siteKey === null) return null;

  return (
    <Turnstile
      ref={widget}
      siteKey={siteKey}
      options={{
        appearance: "interaction-only",
        size: "flexible",
        action: "turnstile-spin-v2",
      }}
      scriptOptions={nonce !== undefined ? { nonce } : undefined}
      onSuccess={(token) => onToken(token)}
      onExpire={() => onToken(null)}
      onError={() => onToken(null)}
    />
  );
}
