import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { AuthLinkButton } from "@/components/auth/AuthLinkButton";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
import { mapBetterAuthError } from "@/lib/actions/team-errors";
import { requireLegalConsent } from "@/lib/auth/consent";
import { getSession } from "@/lib/auth/session";
import { InvitationActions } from "./InvitationActions";

export const dynamic = "force-dynamic";

/**
 * Defensive subset of BA's `getInvitation` response — the endpoint's
 * return type is loose, so a shape surprise degrades to the generic
 * panel instead of a render error.
 */
const invitationSchema = z.object({
  email: z.string(),
  role: z.string().nullish(),
  status: z.string(),
  expiresAt: z.coerce.date(),
  organizationName: z.string(),
  inviterEmail: z.string(),
});

type InvitationDetail = z.infer<typeof invitationSchema>;

interface InvitationPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Time-until-expiry label for invitation copy: "in Xh" under two days,
 * "in Xd" beyond. Expired rows never reach this (BA filters them).
 */
function expiryLabel(expiresAt: Date): string {
  const hours = Math.max(
    1,
    Math.round((expiresAt.getTime() - Date.now()) / 3_600_000),
  );
  return hours >= 48 ? `in ${Math.round(hours / 24)}d` : `in ${hours}h`;
}

/** Centered invitation frame: mono eyebrow + heading + slot content. */
function InviteFrame({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center">
          <span
            className="mb-2 block font-mono text-[10px] font-semibold uppercase"
            style={{
              color: "var(--color-accent-light)",
              letterSpacing: "0.14em",
            }}
          >
            Team invitation
          </span>
          <h1
            className="text-[26px] font-semibold text-text-primary"
            style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
          >
            {heading}
          </h1>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The one panel every failure mode renders: missing, expired, withdrawn,
 * wrong recipient, malformed id, and rate-limited all collapse here so
 * the page discloses nothing about which it was.
 */
function UnavailablePanel() {
  return (
    <InviteFrame heading="Invitation unavailable">
      <p
        className="text-center text-sm text-text-muted"
        style={{ lineHeight: 1.55 }}
      >
        This invitation isn&rsquo;t available. It may have expired, been
        withdrawn, or belong to a different email address. Ask your team admin
        to send a new one.
      </p>
      <p className="text-center text-[12px] text-text-muted">
        <Link
          href="/"
          className="hover:underline"
          style={{ color: "var(--color-accent-light)" }}
        >
          Go to your workspace
        </Link>
      </p>
    </InviteFrame>
  );
}

/** One label/value row inside the invitation detail card. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px]">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="truncate font-mono text-text-secondary">{value}</span>
    </div>
  );
}

/**
 * Invitation recipient page. Public in middleware; the content is gated
 * in layers:
 *
 * - Signed out → a neutral shell with zero invitation details, whose
 *   sign-in/sign-up CTAs carry this page as the `next` destination.
 * - Signed in → consent gate, then a view rate limit, then
 *   `auth.api.getInvitation`, which BA restricts to pending, unexpired
 *   invitations whose email matches the session (anti-enumeration:
 *   every failure renders the same generic panel).
 *
 * @param props - Route params carrying the invitation id.
 * @returns Neutral shell, generic panel, or the invitation detail card.
 */
export default async function InvitationPage({ params }: InvitationPageProps) {
  const { id } = await params;
  const session = await getSession();

  if (!session) {
    const next = encodeURIComponent(`/invitations/${id}`);
    return (
      <InviteFrame heading="You've been invited">
        <p
          className="text-center text-sm text-text-muted"
          style={{ lineHeight: 1.55 }}
        >
          Sign in with the email address this invitation was sent to, and
          we&rsquo;ll bring you right back here.
        </p>
        <div className="flex flex-col gap-2.5">
          <AuthLinkButton href={`/sign-in?next=${next}`}>
            Sign in
          </AuthLinkButton>
          <Link
            href={`/sign-up?next=${next}`}
            className="inline-flex w-full items-center justify-center rounded-lg border text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-hover"
            style={{
              height: 38,
              background: "var(--color-surface-raised)",
              borderColor: "var(--color-border-strong)",
              boxShadow: "var(--shadow-button)",
            }}
          >
            Create an account
          </Link>
        </div>
      </InviteFrame>
    );
  }

  await requireLegalConsent(session.user.id);

  if (!z.uuid().safeParse(id).success) return <UnavailablePanel />;

  const limit = await checkActionRateLimit(
    {
      action: "team.invite_view",
      windowSeconds: 60,
      perUserMax: 30,
      perIpMax: 60,
    },
    session.user.id,
  );
  if (!limit.ok) return <UnavailablePanel />;

  let invitation: InvitationDetail | null = null;
  try {
    const raw = await auth.api.getInvitation({
      query: { id },
      headers: await headers(),
    });
    const parsed = invitationSchema.safeParse(raw);
    if (parsed.success) {
      invitation = parsed.data;
    } else {
      console.error("invitation page unexpected response shape", {
        issues: parsed.error.issues,
      });
    }
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("invitation page getInvitation failed", err);
    }
  }

  if (!invitation || invitation.status !== "pending") {
    return <UnavailablePanel />;
  }

  const role =
    invitation.role === "admin" || invitation.role === "owner"
      ? invitation.role
      : "member";

  return (
    <InviteFrame heading={`Join ${invitation.organizationName}`}>
      <div
        className="space-y-4 rounded-[10px] border p-5"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <div className="space-y-2">
          <DetailRow label="Invited by" value={invitation.inviterEmail} />
          <DetailRow label="Role" value={role} />
          <DetailRow
            label="Expires"
            value={expiryLabel(invitation.expiresAt)}
          />
          <DetailRow label="Signed in as" value={session.user.email} />
        </div>
        <InvitationActions invitationId={id} />
      </div>
    </InviteFrame>
  );
}
