"use client";

import { motion } from "motion/react";
import { IconAgent } from "@/components/shared/icons";
import {
  revokeOAuthSessionAction,
  type OAuthSessionView,
} from "@/lib/actions/oauth-session";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";
import { formatAbsolute, formatRelative } from "@/lib/ui/relative-time";
import { InlineConfirm } from "./InlineConfirm";

interface AgentSessionRowProps {
  /** OAuth session to render. */
  session: OAuthSessionView;
  /** Render a `border-bottom` between rows inside a section card. */
  showDivider: boolean;
  /** Called after a successful revoke so the parent can drop the row. */
  onRevoked: (id: string) => void;
  /** Called after a failed revoke to surface an inline error. */
  onError: (message: string) => void;
}

/**
 * Truncate a session UUID/token id into a short mono label.
 *
 * @param id - Raw refresh-token id from `OAuthSessionView`.
 * @returns Short `mcp_xxxx…yyyy` style identifier suitable for the row.
 */
function truncateSessionId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/**
 * Single MCP session row inside an agent-brand card. Renders the icon tile,
 * the raw registered client name, a mono session id + last-active +
 * organization meta line, and an inline Revoke confirmation that calls
 * `revokeOAuthSessionAction`. The name is shown verbatim (via
 * `formatOAuthClientName`, which never launders an unverified name) so a
 * spoofed client grouped into a family drawer stays visible.
 *
 * @param props - Session row configuration.
 * @returns Animated row matching the prototype's agents tab.
 */
export function AgentSessionRow({
  session,
  showDivider,
  onRevoked,
  onError,
}: AgentSessionRowProps) {
  const handleRevoke = async () => {
    const result = await revokeOAuthSessionAction({ sessionId: session.id });
    if (result.ok) {
      onRevoked(session.id);
    } else {
      onError(result.message);
    }
  };

  const clientLabel = formatOAuthClientName(
    session.clientName,
    session.verified,
  );
  const lastActiveLabel = formatRelative(session.lastActiveAt);
  const tooltip = `Authorized ${formatAbsolute(
    session.authorizedAt,
  )} · Last active ${formatAbsolute(session.lastActiveAt)}`;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.18 }}
      className={`flex items-center gap-3 px-4 py-3.5 ${
        showDivider ? "border-b border-border" : ""
      }`}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface-raised text-accent-light">
        <IconAgent size={14} />
      </div>

      <div className="min-w-0 flex-1" title={tooltip}>
        <p className="truncate text-[12.5px] font-medium text-text-primary">
          {clientLabel}
        </p>
        <p className="mt-0.5 truncate text-[11.5px] text-text-muted">
          <span className="font-mono">{truncateSessionId(session.id)}</span> ·
          last seen {lastActiveLabel}
          {session.organizationName ? ` · ${session.organizationName}` : ""}
        </p>
      </div>

      <InlineConfirm
        trigger={
          <button
            type="button"
            className="cursor-pointer rounded-md px-2.5 py-1 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            Revoke
          </button>
        }
        prompt="Revoke this session?"
        body="The client will need to re-authorize."
        confirmLabel="Revoke"
        destructive
        onConfirm={handleRevoke}
      />
    </motion.div>
  );
}
