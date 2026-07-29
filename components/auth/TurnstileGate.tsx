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
  TURNSTILE_VERIFYING_LABEL,
  turnstileBlockedMessage,
  turnstileTerminal,
  type TurnstileBlockReason,
} from "./turnstile-state";

/** Handle the parent form uses to reach the widget imperatively. */
export interface TurnstileHandle {
  /** Discard the current token and re-run the challenge. */
  reset: () => void;
  /**
   * Resolve the widget's current token, waiting up to
   * {@link CHALLENGE_WAIT_MS} for an in-flight challenge.
   *
   * @returns The token, or `null` when the widget is absent or the wait
   *   times out.
   */
  getToken: () => Promise<string | null>;
}

/**
 * How long to wait for the widget to report itself before assuming the script
 * is dead. `scriptOptions` must NOT carry an `onError` handler: the
 * react-turnstile 1.5.3 injector runs `delete window[onLoadCallbackName]`
 * when one is set, killing the primary onload init path and leaving init to
 * a 50ms polling fallback. This watchdog is therefore the sole
 * transport-failure detector, and it also covers a filter that answers the
 * script request with HTTP 200 and an empty body.
 */
const SCRIPT_WATCHDOG_MS = 10_000;

/**
 * Budget for a challenge run, in two roles: how long a loaded widget's
 * background run may produce neither a token nor an interactive escalation
 * before the stall guard declares it dead, and the submit-time
 * `getResponsePromise` timeout. Deliberately shorter than the library's 30s
 * default so a stuck submit resolves into actionable copy instead of a
 * half-minute dead button.
 */
const CHALLENGE_WAIT_MS = 15_000;

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
 * The token lives in the widget and is acquired at submit time via
 * {@link TurnstileHandle.getToken}, never stored in React state: tokens are
 * single-use with a 300s TTL, and a state copy read minutes later at submit
 * is the documented expiry anti-pattern. The rules live in
 * `turnstile-state.ts`, covered by `tests/ui/turnstile-state.test.ts`.
 *
 * `blockedMessage` is a function, not a string: forms read it after awaiting
 * `getToken`, and a render-time string would carry the reason captured when
 * submit was clicked, not the reason when the wait ended. `reasonRef` keeps
 * the read fresh without re-rendering mid-await.
 *
 * @param siteKey - Public site key, or `null` when Turnstile is unconfigured.
 * @returns `enabled` (is Turnstile configured), `getToken` (submit-time
 *   acquisition, `null` on refusal or timeout), `blockedMessage` (why the
 *   last acquisition refused), `reset`, `verifyingLabel` (button label while
 *   acquiring, else `undefined`), and `gateProps` to spread onto
 *   {@link TurnstileGate}.
 */
export function useTurnstile(siteKey: string | null) {
  const [reason, setReason] = useState<TurnstileBlockReason>("pending");
  const [verifying, setVerifying] = useState(false);
  const reasonRef = useRef<TurnstileBlockReason>("pending");
  const handleRef = useRef<TurnstileHandle | null>(null);

  const applyReason = useCallback((next: TurnstileBlockReason) => {
    reasonRef.current = next;
    setReason(next);
  }, []);

  const reset = useCallback(() => handleRef.current?.reset(), []);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (siteKey === null) return null;
    if (turnstileTerminal(reasonRef.current)) return null;
    setVerifying(true);
    try {
      return (await handleRef.current?.getToken()) ?? null;
    } finally {
      setVerifying(false);
    }
  }, [siteKey]);

  const blockedMessage = useCallback(
    () => turnstileBlockedMessage(reasonRef.current),
    [],
  );

  return {
    enabled: siteKey !== null,
    getToken,
    blockedMessage,
    reset,
    verifyingLabel: verifying ? TURNSTILE_VERIFYING_LABEL : undefined,
    gateProps: {
      handleRef,
      reason,
      onReason: applyReason,
    },
  };
}

interface TurnstileGateProps {
  /** Public site key; `null` disables the widget entirely (self-host). */
  siteKey: string | null;
  /** Per-request CSP nonce, forwarded to Turnstile's injected script. */
  nonce?: string;
  /** Imperative handle for reset and submit-time token acquisition. */
  handleRef?: RefObject<TurnstileHandle | null>;
  /** Why the form is blocked; `unavailable`/`unsupported` render a notice. */
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
 * Because the widget is invisible by design, an invisible run that dies would
 * strand the user with nothing on screen explaining why. Two timers guard
 * that: the script watchdog (widget never reports at all) and the stall guard
 * (widget loaded, but the run produced neither a token nor an interactive
 * escalation within {@link CHALLENGE_WAIT_MS}; re-armed after every reset,
 * expiry, and timeout re-run, since Cloudflare's interaction-only mode is
 * known to not re-show a re-run that escalates). `onBeforeInteractive` clears
 * the guard and flips the reason to `interactive`: the visitor now controls
 * timing, and timing them out would be wrong. Both dead ends land on the
 * `unavailable` notice with its retry affordance.
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
 * The nonce matters: production CSP is `'strict-dynamic'` with a per-request
 * nonce, and Turnstile propagates the nonce it is given to the resources it
 * injects. Without it the widget's own scripts are blocked.
 *
 * `action` is Cloudflare's Spin attribution marker, analytics-only: the
 * server does not configure `expectedAction`, so verification never keys on
 * it.
 *
 * @param props - Site key, CSP nonce, imperative handle, and the
 *   blocked-reason state pair.
 * @returns The widget, or null when Turnstile is not configured.
 */
export function TurnstileGate({
  siteKey,
  nonce,
  handleRef,
  reason,
  onReason,
}: TurnstileGateProps) {
  const widget = useRef<TurnstileInstance | null>(null);
  const settled = useRef(false);
  const stallTimer = useRef<number | null>(null);
  const pendingWaits = useRef<Set<(token: null) => void>>(new Set());

  /**
   * Resolve every in-flight {@link TurnstileHandle.getToken} wait with
   * `null`. Called on each transition to a terminal reason so a submit that
   * is already waiting reports the failure immediately instead of spending
   * the rest of its wait budget on a challenge the gate knows is dead
   * (`getResponsePromise` has no cancellation API, so the race is ours; the
   * losing leg keeps polling at 100ms until the widget next reports solved,
   * for the page's lifetime on a dead script, as harmless no-op work).
   */
  const settleWaits = useCallback(() => {
    for (const resolve of pendingWaits.current) resolve(null);
    pendingWaits.current.clear();
  }, []);

  /** Stop the stalled-challenge timer, if armed. */
  const clearStallGuard = useCallback(() => {
    if (stallTimer.current !== null) {
      window.clearTimeout(stallTimer.current);
      stallTimer.current = null;
    }
  }, []);

  /**
   * (Re)start the stalled-challenge timer: a run that produces neither a
   * token nor an escalation within {@link CHALLENGE_WAIT_MS} is declared
   * dead so the visitor gets the notice instead of an invisible dead end.
   */
  const armStallGuard = useCallback(() => {
    clearStallGuard();
    stallTimer.current = window.setTimeout(() => {
      onReason("unavailable");
      settleWaits();
    }, CHALLENGE_WAIT_MS);
  }, [clearStallGuard, onReason, settleWaits]);

  useEffect(() => clearStallGuard, [clearStallGuard]);

  useImperativeHandle(handleRef, () => ({
    reset: () => {
      // Before any widget callback has fired there is nothing to re-run, and
      // flipping a terminal `unavailable` notice back to `pending` would hide
      // the recovery UI. Ref-nullness cannot gate this; see retry().
      if (!settled.current) return;
      widget.current?.reset();
      onReason("pending");
      armStallGuard();
    },
    getToken: async () => {
      // Null only when Turnstile never rendered (`siteKey` null). A submit
      // before the script loads keeps its wait; the watchdog's terminal race
      // covers a script that never arrives.
      if (widget.current === null) return null;
      let release: (() => void) | undefined;
      const terminal = new Promise<null>((resolve) => {
        pendingWaits.current.add(resolve);
        release = () => pendingWaits.current.delete(resolve);
      });
      try {
        // Rejections (`Timeout`, `No response received`, `Failed to get
        // response`) are message strings, not a stable API; every one means
        // the same thing to the form: no token.
        return await Promise.race([
          widget.current
            .getResponsePromise(CHALLENGE_WAIT_MS)
            .catch(() => null),
          terminal,
        ]);
      } finally {
        release?.();
      }
    },
  }));

  // Watchdog for a script that neither loads nor errors. A filter answering
  // the script request with an empty 200 leaves every Turnstile callback
  // silent, so without this the form blocks forever with no explanation.
  useEffect(() => {
    if (siteKey === null) return;
    const timer = window.setTimeout(() => {
      if (!settled.current) {
        onReason("unavailable");
        settleWaits();
      }
    }, SCRIPT_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [siteKey, onReason, settleWaits]);

  /**
   * Re-run the challenge, falling back to a page reload when the widget
   * never reported and there is nothing to re-run.
   */
  const retry = useCallback(() => {
    // `widget.current` is non-null from first commit even when the script
    // never loads (the library returns the handle unconditionally), so ref
    // nullness cannot detect a dead script. `settled` flips only in real
    // widget callbacks; before that the library reset() only console.warns
    // and a reload is the sole genuine re-attempt.
    if (!settled.current) {
      window.location.reload();
      return;
    }
    onReason("pending");
    widget.current?.reset();
    armStallGuard();
  }, [onReason, armStallGuard]);

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
          scriptOptions={nonce !== undefined ? { nonce } : undefined}
          onWidgetLoad={() => {
            settled.current = true;
            armStallGuard();
          }}
          onSuccess={() => {
            settled.current = true;
            clearStallGuard();
            onReason("pending");
          }}
          onBeforeInteractive={() => {
            clearStallGuard();
            onReason("interactive");
          }}
          onExpire={() => {
            // `refresh-expired` defaults to `auto`, so the widget re-runs on
            // its own. The reset() is for the library, not the widget: success
            // set react-turnstile's internal solved flag and expiry does not
            // clear it, so until the refresh lands getResponsePromise rejects
            // instantly ("No response received") instead of waiting. reset()
            // clears the flag; worst case it duplicates one challenge run per
            // expiry, converging on a single fresh token. A submit during the
            // gap then waits normally, like any other pending run.
            widget.current?.reset();
            onReason("pending");
            armStallGuard();
          }}
          // The widget refreshes itself on timeout too (`refresh-timeout`
          // defaults to `auto`), and unlike expiry a timed-out run never
          // minted a token, so there is no stale solved flag to clear: a
          // reset() here would race the refresh and buy nothing.
          onTimeout={() => {
            onReason("pending");
            armStallGuard();
          }}
          onUnsupported={() => {
            settled.current = true;
            clearStallGuard();
            onReason("unsupported");
            settleWaits();
          }}
          onError={() => {
            settled.current = true;
            clearStallGuard();
            onReason("unavailable");
            settleWaits();
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
