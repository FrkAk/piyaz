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

/** Message shown when a submit lands while the challenge cannot run at all. */
export const TURNSTILE_UNAVAILABLE_MESSAGE =
  "Verification is unavailable, so the form cannot be submitted yet.";

/**
 * Token plumbing shared by every captcha-protected auth form.
 *
 * Collapses the dance each form would otherwise repeat: hold the token, expose
 * a reset handle to clear a spent one, track whether the challenge can run at
 * all, and shape the token into the `fetchOptions` Better Auth forwards as
 * request headers.
 *
 * @param siteKey - Public site key, or `null` when Turnstile is unconfigured.
 * @returns `ready` (may this form submit), `blockedMessage` (why not),
 *   `reset`, a `fetchOptions` builder that yields `undefined` when Turnstile
 *   is off, and `gateProps` to spread onto {@link TurnstileGate}.
 */
export function useTurnstile(siteKey: string | null) {
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const handleRef = useRef<TurnstileHandle | null>(null);

  const reset = useCallback(() => handleRef.current?.reset(), []);

  /**
   * Whether a submit may proceed. Always true when Turnstile is off, so the
   * unconfigured deployment keeps its original behavior. A challenge that
   * cannot run keeps this false: failing open here would let anyone bypass the
   * captcha by blocking the script.
   */
  const ready = siteKey === null || token !== null;

  /**
   * Header carrier for a Better Auth client call. Better Auth reads the token
   * from `x-captcha-response`; there is no client plugin that injects it.
   */
  const fetchOptions =
    token !== null ? { headers: { "x-captcha-response": token } } : undefined;

  return {
    token,
    reset,
    ready,
    fetchOptions,
    blockedMessage: unavailable
      ? TURNSTILE_UNAVAILABLE_MESSAGE
      : TURNSTILE_PENDING_MESSAGE,
    gateProps: {
      onToken: setToken,
      handleRef,
      unavailable,
      onUnavailable: setUnavailable,
    },
  };
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
  /** Whether the challenge failed to run; renders the recovery notice. */
  unavailable: boolean;
  /** Reports a challenge that cannot run, and its recovery. */
  onUnavailable: (unavailable: boolean) => void;
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
 * Because the widget is invisible by design, a challenge that never runs would
 * otherwise strand the user: the form refuses every submit while nothing on
 * the page explains why. Both failure arms therefore surface the notice. The
 * script arm (`scriptOptions.onError`) matters most: when the script itself is
 * blocked, no widget callback ever fires at all.
 *
 * The nonce matters: production CSP is `'strict-dynamic'` with a per-request
 * nonce, and Turnstile propagates the nonce it is given to the resources it
 * injects. Without it the widget's own scripts are blocked.
 *
 * `action` is Cloudflare's Spin attribution marker, analytics-only: the
 * server does not configure `expectedAction`, so verification never keys on
 * it.
 *
 * @param props - Site key, CSP nonce, token callback, reset handle, and the
 *   unavailable state pair.
 * @returns The widget, or null when Turnstile is not configured.
 */
export function TurnstileGate({
  siteKey,
  nonce,
  onToken,
  handleRef,
  unavailable,
  onUnavailable,
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

  /**
   * Re-run the challenge, falling back to a page reload when the script never
   * loaded and there is no widget instance to reset.
   */
  const retry = useCallback(() => {
    if (widget.current === null) {
      window.location.reload();
      return;
    }
    onUnavailable(false);
    onToken(null);
    widget.current.reset();
  }, [onToken, onUnavailable]);

  if (siteKey === null) return null;

  return (
    <>
      <Turnstile
        ref={widget}
        siteKey={siteKey}
        options={{
          appearance: "interaction-only",
          size: "flexible",
          action: "turnstile-spin-v2",
        }}
        scriptOptions={{
          ...(nonce !== undefined && { nonce }),
          onError: () => onUnavailable(true),
        }}
        onSuccess={(token) => {
          onUnavailable(false);
          onToken(token);
        }}
        onExpire={() => onToken(null)}
        onError={() => {
          onToken(null);
          onUnavailable(true);
        }}
      />
      {unavailable ? <TurnstileUnavailableNotice onRetry={retry} /> : null}
    </>
  );
}

/**
 * Recovery notice rendered in the widget's own slot when the challenge cannot
 * run. Names the blocked host in mono so the visitor can find it in whatever
 * is blocking it, and offers the one action that helps.
 *
 * @param props.onRetry - Re-runs the challenge, or reloads when nothing loaded.
 * @returns The notice strip.
 */
function TurnstileUnavailableNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="rise-in flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2.5 text-[12.5px] text-text-secondary"
      style={{
        background: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
        borderColor: "color-mix(in srgb, var(--color-danger) 24%, transparent)",
      }}
    >
      <span>
        Verification could not load. A browser extension or network filter may
        be blocking{" "}
        <span className="font-mono text-text-primary">
          challenges.cloudflare.com
        </span>
        .
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="ml-auto shrink-0 cursor-pointer font-medium underline underline-offset-2"
        style={{ color: "var(--color-accent-light)" }}
      >
        Try again
      </button>
    </div>
  );
}
