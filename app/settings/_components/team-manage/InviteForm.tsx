"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shared/Button";
import { inviteMemberAction } from "@/lib/actions/team";

const INPUT_CLASS =
  "w-full rounded-lg border border-border-strong bg-base px-4 py-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent";

const ROLE_OPTIONS: ReadonlyArray<{
  value: "member" | "admin";
  label: string;
}> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

interface InviteFormProps {
  /** Team UUID — passed to the invite action so admins of T can invite to T from any session. */
  teamId: string;
  /** Whether the deploy can send email; picks the helper copy. */
  emailEnabled: boolean;
  /** Called after a successful invite to refresh the pending list. */
  onInvited: () => Promise<void> | void;
  /** Surface a transient error from the action. */
  onError: (message: string) => void;
}

/**
 * Email-invite form. Creates a Better Auth invitation row for the
 * supplied team; on email-capable deploys the recipient is emailed an
 * `/invitations/<id>` link, otherwise the row waits in the pending list
 * and an admin shares the invite code out-of-band.
 *
 * Owner role is intentionally absent from the role picker: only owners
 * can promote-to-owner anyway, and even owners must invite-then-promote
 * rather than invite directly to the owner role (BA enforces this).
 *
 * @param props - Capability flag + form callbacks.
 * @returns Email + role picker row with Send button.
 */
export function InviteForm({
  teamId,
  emailEnabled,
  onInvited,
  onError,
}: InviteFormProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [pending, startTransition] = useTransition();
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const roleMenuRef = useRef<HTMLDivElement | null>(null);

  const trimmed = email.trim();
  const canSubmit = trimmed.length > 0 && trimmed.includes("@") && !pending;
  const selectedRoleLabel =
    ROLE_OPTIONS.find((option) => option.value === role)?.label ?? "";

  useEffect(() => {
    if (!roleMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (
        roleMenuRef.current &&
        !roleMenuRef.current.contains(event.target as Node)
      ) {
        setRoleMenuOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setRoleMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [roleMenuOpen]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    startTransition(async () => {
      const result = await inviteMemberAction({
        organizationId: teamId,
        email: trimmed,
        role,
      });
      if (!result.ok) {
        onError(result.message);
        return;
      }
      setEmail("");
      await onInvited();
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]"
    >
      <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Invite by email
      </p>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-text-secondary">
            Email address
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="alex@example.com"
            className={INPUT_CLASS}
          />
        </label>
        <div className="lg:w-40">
          <span
            id="invite-role-label"
            className="mb-1 block text-xs font-medium text-text-secondary"
          >
            Role
          </span>
          <div className="relative" ref={roleMenuRef}>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={roleMenuOpen}
              aria-labelledby="invite-role-label"
              onClick={() => setRoleMenuOpen((open) => !open)}
              className={`${INPUT_CLASS} flex cursor-pointer items-center justify-between gap-2 pr-3 text-left`}
            >
              <span>{selectedRoleLabel}</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
                  roleMenuOpen ? "rotate-180" : ""
                }`}
              >
                <path
                  d="M4 6l4 4 4-4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <AnimatePresence>
              {roleMenuOpen ? (
                <motion.ul
                  role="listbox"
                  aria-labelledby="invite-role-label"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow-float)]"
                >
                  {ROLE_OPTIONS.map((option) => {
                    const selected = option.value === role;
                    return (
                      <li key={option.value}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setRole(option.value);
                            setRoleMenuOpen(false);
                          }}
                          className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-hover hover:text-text-primary ${
                            selected
                              ? "text-text-primary"
                              : "text-text-secondary"
                          }`}
                        >
                          <span>{option.label}</span>
                          {selected ? (
                            <svg
                              aria-hidden="true"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              className="h-3.5 w-3.5 text-accent"
                            >
                              <path
                                d="M3.5 8.5l3 3 6-7"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </motion.ul>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!canSubmit}
          isLoading={pending}
        >
          Send invitation
        </Button>
      </div>
      <p className="mt-3 text-xs text-text-muted">
        {emailEnabled
          ? "We'll email them an invitation link and add it to the pending list below."
          : "We'll add a row to the pending list. This deployment can't send email, so share the invite code below instead."}
      </p>
    </form>
  );
}
