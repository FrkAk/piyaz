"use client";

import { useState, useTransition } from "react";
import { motion } from "motion/react";
import { TabSwitcher } from "@/components/shared/TabSwitcher";
import { AuthInput } from "@/components/auth/AuthInput";
import { AuthSubmit } from "@/components/auth/AuthSubmit";
import { DpaConsentCheckbox } from "@/components/shared/DpaConsentCheckbox";
import {
  INVITE_CODE_ALPHABET_PATTERN_SOURCE,
  INVITE_CODE_LENGTH,
} from "@/lib/auth/invite-code-shape";
import { acceptInviteCode, createTeam } from "./actions";

const INVITE_CODE_HTML_PATTERN = `${INVITE_CODE_ALPHABET_PATTERN_SOURCE}{${INVITE_CODE_LENGTH}}`;
const INVITE_CODE_PLACEHOLDER = "8K3jH-pX9_aW2nQ7vB4mF";

/**
 * Build the team-name placeholder from the caller's first name.
 *
 * @param name - Caller display name; may be null/undefined.
 * @returns "{Name}'s Team" or a generic fallback.
 */
function teamNamePlaceholder(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${first}'s Team` : "My Team";
}

/**
 * Build the slug placeholder — the team-name placeholder lowercased and hyphenated.
 *
 * @param name - Caller display name; may be null/undefined.
 * @returns "{name}-team" or a generic fallback.
 */
function slugPlaceholder(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0]?.toLowerCase();
  return first ? `${first}-team` : "my-team";
}

const TABS = [
  { id: "create", label: "Create team" },
  { id: "join", label: "Join with code" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface OnboardingFormProps {
  /** Caller's display name — first word becomes "{name}'s Team" placeholder. */
  userName?: string | null;
}

/**
 * Onboarding form — lets the signed-in user create a new team or join an
 * existing one with a 21-char invite code. Both branches dispatch to
 * server actions in `./actions.ts` which delegate to `lib/actions/team.ts`
 * and `lib/actions/team-invite-code.ts`.
 *
 * @param props - Optional caller display name for personalized placeholders.
 * @returns Card-shaped form panel with create/join tabs.
 */
export function OnboardingForm({ userName }: OnboardingFormProps = {}) {
  const [tab, setTab] = useState<TabId>("create");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dpaAccepted, setDpaAccepted] = useState(false);

  /**
   * Switch tabs and clear any stale error from the previous tab.
   *
   * @param next - Tab id to activate.
   */
  function handleTabChange(next: string) {
    setTab(next as TabId);
    setError(null);
  }

  return (
    <div
      className="rounded-[10px] border p-5"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-border)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <TabSwitcher
        tabs={[...TABS]}
        activeTab={tab}
        onTabChange={handleTabChange}
        stretch
        className="mb-5"
      />

      <motion.div
        layout
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        style={{ overflow: "hidden" }}
      >
        {tab === "create" ? (
          <form
            action={(formData) => {
              const name = String(formData.get("name") ?? "");
              const slug = String(formData.get("slug") ?? "");
              startTransition(async () => {
                const result = await createTeam({ name, slug, dpaAccepted });
                if (!result.ok) setError(result.message);
              });
            }}
            className="flex flex-col gap-3"
          >
            <AuthInput
              label="Team name"
              name="name"
              required
              maxLength={64}
              placeholder={teamNamePlaceholder(userName)}
            />
            <AuthInput
              label="URL slug"
              name="slug"
              required
              minLength={2}
              maxLength={32}
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
              placeholder={slugPlaceholder(userName)}
              hint="Lowercase letters, digits, hyphens. 2–32 characters."
              className="font-mono"
            />
            <div className="mt-0.5">
              <DpaConsentCheckbox
                checked={dpaAccepted}
                onChange={setDpaAccepted}
              />
            </div>
            <AuthSubmit isLoading={pending} disabled={!dpaAccepted}>
              Create team
            </AuthSubmit>
          </form>
        ) : (
          <form
            action={(formData) => {
              const code = String(formData.get("code") ?? "");
              startTransition(async () => {
                const result = await acceptInviteCode({ code });
                if (!result.ok) setError(result.message);
              });
            }}
            className="flex flex-col gap-3"
          >
            <AuthInput
              label="Invite code"
              name="code"
              required
              minLength={INVITE_CODE_LENGTH}
              maxLength={INVITE_CODE_LENGTH}
              pattern={INVITE_CODE_HTML_PATTERN}
              autoComplete="off"
              spellCheck={false}
              placeholder={INVITE_CODE_PLACEHOLDER}
              hint="Paste the 21-character invite code your team admin shared."
              className="font-mono tracking-wider"
            />
            <AuthSubmit isLoading={pending}>Join team</AuthSubmit>
          </form>
        )}
      </motion.div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border px-3 py-2 text-[12px] text-danger"
          style={{
            background:
              "color-mix(in srgb, var(--color-danger) 10%, transparent)",
            borderColor:
              "color-mix(in srgb, var(--color-danger) 24%, transparent)",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
