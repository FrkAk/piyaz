import { redirect } from "next/navigation";
import { requireLegalConsent } from "@/lib/auth/consent";
import { requireSession } from "@/lib/auth/session";
import { userHasAnyMembership } from "@/lib/data/membership";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { OnboardingForm } from "./OnboardingForm";

export const dynamic = "force-dynamic";

/**
 * Onboarding page for teams (Better Auth organizations). When the caller
 * already belongs to any team, redirect home — the workspace spans every
 * team they're a member of, so there is nothing to "activate". Otherwise
 * render the create-or-join form.
 *
 * Visual chrome follows the Phase 6 auth language: gradient brand stamp,
 * mono eyebrow, single-column centered card. The form itself owns the
 * tabs and server-action wiring.
 *
 * @returns Server-rendered onboarding UI.
 */
export default async function OnboardingTeamPage() {
  const session = await requireSession();
  await requireLegalConsent(session.user.id);

  if (await userHasAnyMembership(session.user.id)) redirect("/");

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <AuthBrand />
        <span
          className="mb-2 block font-mono text-[10px] font-semibold uppercase"
          style={{
            color: "var(--color-accent-light)",
            letterSpacing: "0.14em",
          }}
        >
          Onboarding · Team
        </span>
        <h1
          className="mb-2 text-[26px] font-semibold text-text-primary"
          style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
        >
          Pick a team to land in.
        </h1>
        <p
          className="mb-7 text-[13.5px] text-text-muted"
          style={{ lineHeight: 1.55 }}
        >
          Piyaz is team-scoped. Create a fresh workspace, or paste the
          21-character invite code your team admin shared.
        </p>
        <OnboardingForm userName={session.user.name} />
      </div>
    </div>
  );
}
