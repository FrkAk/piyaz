/**
 * Social-OAuth row + email divider for the auth pages.
 *
 * GitHub and Google sign-in are not yet wired in `lib/auth.ts` — the
 * server enables `emailAndPassword` only, no `socialProviders`. Until a
 * provider is configured, the buttons render disabled with a "coming
 * soon" tooltip following the §11 convention. Re-enable by switching
 * `disabled={false}` and pointing each `onClick` at
 * `signIn.social({ provider: 'github' | 'google' })`.
 *
 * The divider beneath the buttons separates the third-party row from the
 * email/password form.
 *
 * @returns Vertical stack of two social buttons + mono divider.
 */
export function SocialButtons() {
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <SocialButton
          label="Continue with GitHub"
          icon={<GithubMark />}
          tooltip="GitHub sign-in coming soon"
        />
        <SocialButton
          label="Continue with Google"
          icon={<GoogleMark />}
          tooltip="Google sign-in coming soon"
        />
      </div>
      <EmailDivider />
    </>
  );
}

interface SocialButtonProps {
  /** Visible button label, e.g. "Continue with GitHub". */
  label: string;
  /** Inline brand SVG rendered to the left of the label. */
  icon: React.ReactNode;
  /** Tooltip surfaced on hover and to assistive tech via aria-label. */
  tooltip: string;
}

/**
 * Single social-provider button — surface bg, 38px height, disabled
 * pending backend wiring. Hover/focus keep the disabled affordance via
 * `cursor-not-allowed` + opacity.
 *
 * @param props - Label, brand icon, and tooltip explaining the disabled state.
 * @returns Disabled `<button>` with `title` and `aria-label` set.
 */
function SocialButton({ label, icon, tooltip }: SocialButtonProps) {
  return (
    <button
      type="button"
      disabled
      title={tooltip}
      aria-label={tooltip}
      className="inline-flex w-full cursor-not-allowed items-center justify-center gap-2.5 bg-surface px-3.5 text-[13px] font-medium text-text-primary opacity-80"
      style={{
        height: 38,
        borderRadius: 8,
        border: "1px solid var(--color-border-strong)",
        boxShadow: "var(--shadow-button)",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/** Mono "OR WITH EMAIL" divider — flanked by hairline rules. */
function EmailDivider() {
  return (
    <div
      className="my-5 flex items-center gap-2.5"
      style={{ color: "var(--color-text-faint)" }}
    >
      <span
        aria-hidden="true"
        className="h-px flex-1"
        style={{ background: "var(--color-border)" }}
      />
      <span
        className="font-mono text-[10px] font-semibold uppercase"
        style={{ letterSpacing: "0.10em" }}
      >
        or with email
      </span>
      <span
        aria-hidden="true"
        className="h-px flex-1"
        style={{ background: "var(--color-border)" }}
      />
    </div>
  );
}

/** GitHub Octocat mark — monochrome, follows currentColor for tone. */
function GithubMark() {
  return (
    <svg
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      style={{ flexShrink: 0 }}
    >
      <path
        fill="currentColor"
        d="M12 1.5C5.65 1.5.5 6.65.5 13c0 5.08 3.29 9.39 7.86 10.92.58.1.79-.25.79-.55v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18.92-.26 1.9-.38 2.88-.39.98 0 1.96.13 2.88.39 2.19-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.83 1.18 3.08 0 4.42-2.69 5.4-5.25 5.69.41.36.77 1.06.77 2.13v3.16c0 .31.21.66.8.55C20.21 22.39 23.5 18.08 23.5 13c0-6.35-5.15-11.5-11.5-11.5z"
      />
    </svg>
  );
}

/** Google "G" mark — official multicolor brand glyph. */
function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 18 18"
      style={{ flexShrink: 0 }}
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.81.54-1.83.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A8.99 8.99 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A8.99 8.99 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.99 8.99 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
