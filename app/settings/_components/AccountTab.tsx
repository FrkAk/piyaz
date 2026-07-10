"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shared/Button";
import { initials } from "@/lib/ui/initials";
import { teamAvatarGradient } from "@/lib/ui/team-avatar";
import { formatAbsolute } from "@/lib/ui/relative-time";
import {
  exportAccountDataAction,
  updateProfileAction,
} from "@/lib/actions/profile";
import { changePasswordAction } from "@/lib/actions/password";
import { DeleteAccountDialog } from "./DeleteAccountDialog";

const NAME_MAX = 80;
const PASSWORD_MIN = 8;

/** Legal documents linked from the account tab, opened in a new tab. */
const LEGAL_DOC_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/impressum", label: "Legal Notice" },
  { href: "/dpa", label: "DPA" },
  { href: "/subprocessors", label: "Sub-processors" },
];

const INPUT_CLASS =
  "w-full rounded-md border border-border-strong bg-base px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent";

const FIELD_LABEL_CLASS =
  "mb-1.5 block text-[11.5px] font-medium text-text-muted";

interface AccountTabProps {
  /** Identity slice for the signed-in user. */
  user: {
    id: string;
    name: string;
    email: string;
    createdAt: Date | string;
  };
  /** Credential row's updatedAt (password last changed); null hides the
   *  password card (no password-bearing credential account). */
  passwordUpdatedAt: Date | string | null;
}

/**
 * Account tab — identity card (56px gradient avatar, locked email, editable
 * display name), password card (collapsed disclosure backed by
 * `changePasswordAction`), and a danger-zone card wiring the data export
 * (`exportAccountDataAction`) and account deletion (`DeleteAccountDialog`).
 * Photo upload remains a wired-once-backend-lands placeholder — see DESIGN
 * §11 conventions for non-functional buttons.
 *
 * @param props - Identity slice + password metadata.
 * @returns Tab body with H1, identity card, password card, danger zone.
 */
export function AccountTab({ user, passwordUpdatedAt }: AccountTabProps) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== user.name.trim();
  const gradient = teamAvatarGradient(user.id);
  const memberSince = formatAbsolute(user.createdAt);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setError(null);
    startTransition(async () => {
      const result = await updateProfileAction({ name: trimmed });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 900);
      router.refresh();
    });
  };

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold leading-tight text-text-primary">
          Account
        </h1>
        <p className="mt-1 text-[13px] text-text-muted">
          How you appear to teammates and agents.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="relative rounded-[10px] border border-border bg-surface p-5 shadow-[var(--shadow-card)]"
      >
        <AnimatePresence>
          {savedFlash ? (
            <motion.span
              key="saved-flash"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45, ease: "easeOut" }}
              className="pointer-events-none absolute inset-0 rounded-[10px] shadow-[var(--shadow-glow-done)]"
            />
          ) : null}
        </AnimatePresence>

        <div className="flex items-center gap-4">
          <div
            aria-hidden="true"
            style={{
              background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
            }}
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white shadow-[var(--shadow-card)]"
          >
            {initials({ name: user.name, email: user.email })}
          </div>
          <div>
            <Button
              variant="secondary"
              size="md"
              disabled
              className="opacity-80"
            >
              <span title="Photo upload — coming soon">Upload photo</span>
            </Button>
            <p className="mt-1.5 text-[11.5px] text-text-muted">
              JPG or PNG, max 2MB
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <label className="block">
            <span className={FIELD_LABEL_CLASS}>Display name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={NAME_MAX}
              placeholder="Your name"
              className={INPUT_CLASS}
            />
          </label>

          <label className="block">
            <span className={FIELD_LABEL_CLASS}>Email</span>
            <input
              type="email"
              value={user.email}
              disabled
              aria-readonly="true"
              className={`${INPUT_CLASS} cursor-not-allowed text-text-muted`}
              title="Email is your sign-in identity and can't be changed here."
            />
            <p className="mt-1 text-[11px] text-text-muted">
              Sign-in identity — managed by your auth provider.
            </p>
          </label>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-[11.5px] text-text-muted">
              Member since {memberSince}
            </p>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={!dirty}
              isLoading={pending}
            >
              Save changes
            </Button>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-cancelled/25 bg-cancelled/10 px-3 py-2 text-[12px] text-cancelled"
            >
              {error}
            </p>
          ) : null}
        </div>
      </form>

      {passwordUpdatedAt !== null ? (
        <PasswordSection lastChanged={passwordUpdatedAt} />
      ) : null}

      <DangerZone email={user.email} />

      <nav
        aria-label="Legal documents"
        className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[11.5px] text-text-muted"
      >
        {LEGAL_DOC_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-text-primary"
          >
            {link.label}
          </a>
        ))}
      </nav>
    </section>
  );
}

/**
 * Password card — collapsed disclosure showing a masked motif plus the
 * last-changed date; expands into current/new/confirm fields submitted
 * through `changePasswordAction`. A successful change revokes every other
 * session and all authorized agents server-side, so the helper copy says
 * exactly that. Collapse resets all field state so reopening always starts
 * clean.
 *
 * @param props - `lastChanged` from the credential account row.
 * @returns Card with disclosure form between identity card and danger zone.
 */
function PasswordSection({ lastChanged }: { lastChanged: Date | string }) {
  const router = useRouter();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  // isPending only flips after a re-render, so two submits in one event
  // batch (double Enter) would both pass the `pending` guard and fire two
  // server actions — burning two rate-limit slots and landing the loser's
  // stale error on the collapsed form. The ref closes synchronously.
  const inFlightRef = useRef(false);

  const mismatch =
    confirmPassword.length > 0 && confirmPassword !== newPassword;
  const sameAsCurrent =
    newPassword.length > 0 && newPassword === currentPassword;
  const submittable =
    currentPassword.length > 0 &&
    newPassword.length >= PASSWORD_MIN &&
    newPassword !== currentPassword &&
    confirmPassword === newPassword;

  const close = () => {
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && !pending) close();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!submittable || pending || inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await changePasswordAction({
          currentPassword,
          newPassword,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        close();
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 900);
        router.refresh();
      } catch {
        setError(
          "Something went wrong reaching the server. Check your connection and try again.",
        );
      } finally {
        inFlightRef.current = false;
      }
    });
  };

  return (
    <section className="relative rounded-[10px] border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
      <AnimatePresence>
        {savedFlash ? (
          <motion.span
            key="password-saved-flash"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
            className="pointer-events-none absolute inset-0 rounded-[10px] shadow-[var(--shadow-glow-done)]"
          />
        ) : null}
      </AnimatePresence>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-text-primary">
            Password
          </p>
          <p
            aria-hidden="true"
            className="mt-0.5 select-none text-[13px] leading-none tracking-[0.2em] text-text-muted"
          >
            ••••••••••
          </p>
          <p className="mt-1.5 text-[11.5px] text-text-muted">
            Last changed {formatAbsolute(lastChanged)}
          </p>
        </div>
        {!open ? (
          <Button variant="secondary" size="md" onClick={() => setOpen(true)}>
            Change password
          </Button>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="password-form"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{ overflow: "hidden" }}
          >
            <form
              onSubmit={handleSubmit}
              onKeyDown={handleKeyDown}
              className="mt-5 space-y-4"
            >
              <label className="block">
                <span className={FIELD_LABEL_CLASS}>Current password</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                  className={INPUT_CLASS}
                />
              </label>

              <label className="block">
                <span className={FIELD_LABEL_CLASS}>New password</span>
                {/* No maxLength: clipping a pasted 140-char generated
                    password here would silently store the truncated form.
                    The zod max in changePasswordAction rejects loudly. */}
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  aria-invalid={sameAsCurrent ? true : undefined}
                  aria-describedby={
                    sameAsCurrent
                      ? `${fieldId}-new-error`
                      : `${fieldId}-new-hint`
                  }
                  className={INPUT_CLASS}
                />
                {sameAsCurrent ? (
                  <p
                    id={`${fieldId}-new-error`}
                    role="alert"
                    className="mt-1 text-[11px] text-cancelled"
                  >
                    New password must be different from your current one.
                  </p>
                ) : (
                  <p
                    id={`${fieldId}-new-hint`}
                    className="mt-1 text-[11px] text-text-muted"
                  >
                    At least {PASSWORD_MIN} characters.
                  </p>
                )}
              </label>

              <label className="block">
                <span className={FIELD_LABEL_CLASS}>Confirm new password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  aria-invalid={mismatch ? true : undefined}
                  aria-describedby={
                    mismatch ? `${fieldId}-confirm-error` : undefined
                  }
                  className={INPUT_CLASS}
                />
                {mismatch ? (
                  <p
                    id={`${fieldId}-confirm-error`}
                    role="alert"
                    className="mt-1 text-[11px] text-cancelled"
                  >
                    Passwords don&apos;t match.
                  </p>
                ) : null}
              </label>

              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                <p className="min-w-0 text-[11.5px] leading-relaxed text-text-muted">
                  Changing your password signs out all your other devices and
                  revokes connected agents.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    onClick={close}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    disabled={!submittable}
                    isLoading={pending}
                  >
                    Change password
                  </Button>
                </div>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-md border border-cancelled/25 bg-cancelled/10 px-3 py-2 text-[12px] text-cancelled"
                >
                  {error}
                </p>
              ) : null}
            </form>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/**
 * Danger-zone card — wires the GDPR data export ("Download my data",
 * `exportAccountDataAction`) and account deletion (typed-confirmation
 * `DeleteAccountDialog`). The delete copy states the resolved sole-owner
 * semantics: solely-owned teams with no other members are deleted with the
 * account, while teams the user solely owns that still have other members
 * block deletion until ownership is transferred or the team is deleted.
 *
 * @param props - `email` for the confirmation dialog.
 * @returns Cancelled-tinted card with the export and delete controls.
 */
function DangerZone({ email }: { email: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [exporting, startExport] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = () => {
    setExportError(null);
    startExport(async () => {
      const result = await exportAccountDataAction();
      if (!result.ok) {
        setExportError(result.message);
        return;
      }
      const blob = new Blob([JSON.stringify(result.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "piyaz-account-export.json";
      anchor.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <section className="rounded-[10px] border border-cancelled/25 bg-cancelled/5 p-5">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cancelled">
        Danger zone
      </p>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-text-primary">
            Download my data
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
            Export your profile, team memberships, and legal-acceptance records
            as a JSON file.
          </p>
        </div>
        <Button
          variant="secondary"
          size="md"
          onClick={handleExport}
          isLoading={exporting}
        >
          Download my data
        </Button>
      </div>

      {exportError ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-cancelled/25 bg-cancelled/10 px-3 py-2 text-[12px] text-cancelled"
        >
          {exportError}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4 border-t border-cancelled/20 pt-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-text-primary">
            Delete account
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
            Permanently remove your account and revoke every authorized agent.
            Teams you solely own with no other members are deleted with the
            account; a team you solely own that still has other members must
            have ownership transferred or be deleted first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-cancelled/30 bg-cancelled/10 px-3 text-[12px] font-semibold text-cancelled transition-colors hover:border-cancelled hover:bg-cancelled/20"
        >
          Delete account
        </button>
      </div>

      <DeleteAccountDialog
        open={dialogOpen}
        email={email}
        onClose={() => setDialogOpen(false)}
      />
    </section>
  );
}
