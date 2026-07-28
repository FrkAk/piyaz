"use client";

import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import { AuthNotice, NoticeHost } from "./AuthNotice";
import {
  TURNSTILE_UNAVAILABLE_NOTICE,
  TURNSTILE_UNSUPPORTED_NOTICE,
  turnstileBlockedMessage,
  turnstileFetchOptions,
  turnstileReady,
  type TurnstileBlockReason,
} from "./turnstile-state";

/** Handle the parent form uses to clear a spent token after a failed submit. */
export interface TurnstileHandle {
  /** Discard the current token and re-run the challenge. */
  reset: () => void;
}

/**
 * How long to wait for the widget to report itself before assuming the script
 * is dead. `scriptOptions.onError` only fires on a transport error, so a
 * network filter that answers the script request with HTTP 200 and an empty
 * body leaves every callback silent and the form permanently unsubmittable.
 */
const SCRIPT_WATCHDOG_MS = 10_000;

/**
 * Replaces the wrapper react-turnstile would otherwise impose.
 *
 * Under `appearance: "interaction-only"` the library styles its wrapper
 * `width: fit-content; display: flex`, which fights `size: "flexible"` twice
 * over: `fit-content` gives Cloudflare no container width to expand into, and
 * a flex item does not stretch along the main axis. `display: block` at full
 * width hands Cloudflare a plain box to measure.
 */
const TURNSTILE_SLOT_STYLE = { width: "100%", display: "block" } as const;

/**
 * Token plumbing shared by every captcha-protected auth form.
 *
 * Collapses the dance each form would otherwise repeat: hold the token, expose
 * a reset handle to clear a spent one, track why the form is blocked, and
 * shape the token into the `fetchOptions` Better Auth forwards as request
 * headers. The rules themselves live in `turnstile-state.ts`, which is covered
 * directly by `tests/ui/turnstile-state.test.ts`.
 *
 * @param siteKey - Public site key, or `null` when Turnstile is unconfigured.
 * @returns `ready` (may this form submit), `blockedMessage` (why not),
 *   `reset`, a `fetchOptions` builder that yields `undefined` when Turnstile
 *   is off, and `gateProps` to spread onto {@link TurnstileGate}.
 */
export function useTurnstile(siteKey: string | null) {
  const [token, setToken] = useState<string | null>(null);
  const [reason, setReason] = useState<TurnstileBlockReason>("pending");
  const handleRef = useRef<TurnstileHandle | null>(null);

  const reset = useCallback(() => handleRef.current?.reset(), []);

  return {
    token,
    reset,
    ready: turnstileReady(siteKey, token),
    fetchOptions: turnstileFetchOptions(token),
    blockedMessage: turnstileBlockedMessage(reason),
    gateProps: {
      onToken: setToken,
      handleRef,
      reason,
      onReason: setReason,
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
  /** Why the form is blocked; anything but `pending` renders a notice. */
  reason: TurnstileBlockReason;
  /** Reports a change in the blocked reason. */
  onReason: (reason: TurnstileBlockReason) => void;
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
 * warranted. That behavior needs the dashboard widget to be **Managed** mode;
 * on an Invisible widget the appearance setting is a documented no-op, and on
 * Non-Interactive it would mean the widget is never shown at all.
 *
 * Sizing is `size: "flexible"` over {@link TURNSTILE_SLOT_STYLE}, which
 * replaces the wrapper the library would otherwise impose. See that constant
 * for why both halves are needed and what each one guards.
 *
 * Every call site renders this **below** the form's submit control. An
 * escalated challenge is ~65px tall and appears with no warning, so anywhere
 * above the button it would shove the button out from under the pointer at the
 * exact moment the visitor is reaching for it. Cloudflare publishes no
 * guidance on reserving space, and permanently reserving 65px of blank space
 * on every auth form to protect against a rare escalation is a worse trade
 * than ordering the slot after the button.
 *
 * Because the widget is invisible by design, a challenge that never runs would
 * otherwise strand the user: the form refuses every submit while nothing on
 * the page explains why. All three failure arms therefore surface a notice,
 * and an unsupported browser gets its own terminal copy with no retry, since
 * retrying re-runs the same detection.
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
 *   blocked-reason state pair.
 * @returns The widget, or null when Turnstile is not configured.
 */
export function TurnstileGate({
  siteKey,
  nonce,
  onToken,
  handleRef,
  reason,
  onReason,
}: TurnstileGateProps) {
  const widget = useRef<TurnstileInstance | null>(null);
  const settled = useRef(false);

  useImperativeHandle(handleRef, () => ({
    reset: () => {
      // Tokens are single-use with a 300s TTL, so a spent token left in the
      // widget turns one failed submit into a permanently failing form.
      widget.current?.reset();
      onToken(null);
    },
  }));

  // Watchdog for a script that neither loads nor errors. A filter answering
  // the script request with an empty 200 leaves every Turnstile callback
  // silent, so without this the form blocks forever with no explanation.
  useEffect(() => {
    if (siteKey === null) return;
    const timer = window.setTimeout(() => {
      if (!settled.current) onReason("unavailable");
    }, SCRIPT_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [siteKey, onReason]);

  /**
   * Re-run the challenge, falling back to a page reload when the script never
   * loaded and there is no widget instance to reset.
   */
  const retry = useCallback(() => {
    if (widget.current === null) {
      window.location.reload();
      return;
    }
    onReason("pending");
    onToken(null);
    widget.current.reset();
  }, [onToken, onReason]);

  if (siteKey === null) return null;

  return (
    <>
      {/*
        `mx-auto` on the iframe is what actually centres the challenge:
        Tailwind's preflight sets `iframe { display: block }`, so a block-level
        element ignores `text-align`, and auto inline margins are the only
        thing that will centre it. This keeps the slot looking deliberate at
        whatever width Cloudflare picks, rather than depending on `flexible`
        filling the column. `overflow-x` is the mobile guard: `flexible` will
        not render below 300px and the auth column is narrower than that under
        a ~348px viewport, so without it the whole page gains a horizontal
        scrollbar instead of just this strip.
      */}
      <div className="w-full overflow-x-auto [&_iframe]:mx-auto">
        <Turnstile
          ref={widget}
          siteKey={siteKey}
          options={{
            appearance: "interaction-only",
            size: "flexible",
            action: "turnstile-spin-v2",
          }}
          style={TURNSTILE_SLOT_STYLE}
          scriptOptions={{
            ...(nonce !== undefined && { nonce }),
            onError: () => {
              settled.current = true;
              onReason("unavailable");
            },
          }}
          onWidgetLoad={() => {
            settled.current = true;
          }}
          onSuccess={(token) => {
            settled.current = true;
            onReason("pending");
            onToken(token);
          }}
          onExpire={() => onToken(null)}
          // The widget refreshes itself on timeout (`refresh-timeout` defaults
          // to `auto`), so calling reset() here would race it. Only the dead
          // token needs clearing.
          onTimeout={() => onToken(null)}
          onUnsupported={() => {
            settled.current = true;
            onToken(null);
            onReason("unsupported");
          }}
          onError={() => {
            settled.current = true;
            onToken(null);
            onReason("unavailable");
          }}
        />
      </div>
      {reason === "unavailable" ? (
        <AuthNotice action={{ label: "Try again", onClick: retry }}>
          {TURNSTILE_UNAVAILABLE_NOTICE.before}{" "}
          <NoticeHost>{TURNSTILE_UNAVAILABLE_NOTICE.host}</NoticeHost>
          {TURNSTILE_UNAVAILABLE_NOTICE.after}
        </AuthNotice>
      ) : null}
      {reason === "unsupported" ? (
        // No action: a reset re-runs the same browser detection and fails
        // identically, so offering one would cost the visitor a click and
        // teach them the control does nothing.
        <AuthNotice tone="muted">{TURNSTILE_UNSUPPORTED_NOTICE}</AuthNotice>
      ) : null}
    </>
  );
}
