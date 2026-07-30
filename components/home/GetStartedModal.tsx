"use client";

import { useState, useSyncExternalStore } from "react";
import { Modal } from "@/components/shared/Modal";
import { CopyButton } from "@/components/shared/CopyButton";
import { TabSwitcher } from "@/components/shared/TabSwitcher";

interface GetStartedModalProps {
  /** @param open - Whether the modal is visible. */
  open: boolean;
  /** @param onClose - Called when the modal requests dismissal. */
  onClose: () => void;
}

interface CliInstallFollowUp {
  label: string;
  text: string;
}

interface CliInstall {
  name: string;
  install: string;
  setupNote: string;
  /** Skill invocation prefix this harness uses in the example prompts. */
  invocation: string;
  /** Optional labeled follow-up (auto-update, skills install). */
  followUp?: CliInstallFollowUp;
}

const HOSTED_DEPLOY_TARGET = "cloudflare";

const CLAUDE_STAY_CURRENT: CliInstallFollowUp = {
  label: "Stay current",
  text: "Run /plugin, open Marketplaces, select piyaz, and choose Enable auto-update. Claude Code prompts /reload-plugins when a new release lands.",
};

const ANTIGRAVITY_SKILLS_HOSTED: CliInstallFollowUp = {
  label: "Add the skills",
  text: "Clone github.com/FrkAk/piyaz and copy plugins/antigravity into ~/.gemini/config/plugins, or .agents/plugins at your workspace root. This installs the /piyaz skill used in step 02.",
};

const ANTIGRAVITY_SKILLS_SELF_HOST: CliInstallFollowUp = {
  label: "Add the skills",
  text: "Copy plugins/antigravity from your checkout into ~/.gemini/config/plugins, or .agents/plugins at your workspace root. This installs the /piyaz skill used in step 02.",
};

const CURSOR_SKILLS: CliInstallFollowUp = {
  label: "Add the skills",
  text: "Team and Enterprise plans: Settings, Plugins, Team Marketplaces, Import from Repo, then paste https://github.com/FrkAk/piyaz. Without the skills, describe your project in chat and the MCP tools still respond.",
};

const HOSTED_CLI_INSTALLS: readonly CliInstall[] = [
  {
    name: "Claude Code",
    install:
      "claude plugin marketplace add FrkAk/piyaz\nclaude plugin install piyaz@piyaz",
    setupNote:
      "Run /mcp, select piyaz, and complete the browser sign-in. The piyaz skill auto-invokes when you talk about projects.",
    invocation: "/piyaz",
    followUp: CLAUDE_STAY_CURRENT,
  },
  {
    name: "Codex",
    install: "codex plugin marketplace add FrkAk/piyaz",
    setupNote:
      "Run /plugin, install Piyaz, restart Codex, and authenticate when prompted. Invoke the main skill with $piyaz.",
    invocation: "$piyaz",
  },
  {
    name: "Antigravity",
    install:
      '{\n  "mcpServers": {\n    "piyaz": { "serverUrl": "https://app.piyaz.ai/api/mcp" }\n  }\n}',
    setupNote:
      "Add this to ~/.gemini/config/mcp_config.json (%USERPROFILE%\\.gemini\\config\\mcp_config.json on Windows), then run /mcp and Authenticate. Antigravity handles OAuth automatically.",
    invocation: "/piyaz",
    followUp: ANTIGRAVITY_SKILLS_HOSTED,
  },
  {
    name: "Cursor",
    install:
      "cursor://anysphere.cursor-deeplink/mcp/install?name=piyaz&config=eyJ1cmwiOiJodHRwczovL2FwcC5waXlhei5haS9hcGkvbWNwIn0=",
    setupNote:
      "Open the deeplink, then sign in when the first Piyaz MCP tool call triggers OAuth.",
    invocation: "/piyaz",
    followUp: CURSOR_SKILLS,
  },
];

const DEFAULT_SELF_HOST_ENDPOINT = "http://localhost:3000/api/mcp";

/**
 * Claude Code and Codex install the plugin from the public marketplace;
 * Antigravity and Cursor register the server via config JSON and pick up the
 * skills through their follow-up notes. Every snippet registers a second
 * server, `piyaz-self-hosted`, against the reader's own instance rather than
 * editing the plugin's bundled config, which lives in a version-scoped cache
 * the next plugin update overwrites. Endpoints are substituted with the live
 * instance origin in {@link getCliInstalls}.
 */
const SELF_HOST_CLI_INSTALLS: readonly CliInstall[] = [
  {
    name: "Claude Code",
    install: `claude plugin marketplace add FrkAk/piyaz\nclaude plugin install piyaz@piyaz\nclaude mcp add -s user --transport http piyaz-self-hosted ${DEFAULT_SELF_HOST_ENDPOINT}\nclaude mcp login piyaz-self-hosted`,
    setupNote:
      "mcp login needs Claude Code v2.1.186 or later; on older versions run /mcp and authenticate against piyaz-self-hosted.",
    invocation: "/piyaz",
    followUp: CLAUDE_STAY_CURRENT,
  },
  {
    name: "Codex",
    install: `codex plugin marketplace add FrkAk/piyaz\ncodex mcp add piyaz-self-hosted --url ${DEFAULT_SELF_HOST_ENDPOINT}\ncodex mcp login piyaz-self-hosted`,
    setupNote:
      "Run /plugin, install Piyaz, and restart Codex first. Invoke the main skill with $piyaz.",
    invocation: "$piyaz",
  },
  {
    name: "Antigravity",
    install: `{\n  "mcpServers": {\n    "piyaz-self-hosted": { "serverUrl": "${DEFAULT_SELF_HOST_ENDPOINT}" }\n  }\n}`,
    setupNote:
      "Merge into mcpServers in ~/.gemini/config/mcp_config.json (%USERPROFILE%\\.gemini\\config\\mcp_config.json on Windows). Restart Antigravity, run /mcp, and authenticate against piyaz-self-hosted.",
    invocation: "/piyaz",
    followUp: ANTIGRAVITY_SKILLS_SELF_HOST,
  },
  {
    name: "Cursor",
    install: `{\n  "mcpServers": {\n    "piyaz-self-hosted": { "url": "${DEFAULT_SELF_HOST_ENDPOINT}" }\n  }\n}`,
    setupNote:
      "Merge into mcpServers in ~/.cursor/mcp.json (%USERPROFILE%\\.cursor\\mcp.json on Windows), then restart Cursor. OAuth runs on the first tool call.",
    invocation: "/piyaz",
    followUp: CURSOR_SKILLS,
  },
];

const HOSTED_DOCS_SETUP_URL = "https://docs.piyaz.ai/docs/";
const SELF_HOST_DOCS_SETUP_URL = "https://docs.piyaz.ai/docs/guides/self-host";

const SECTION_LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted";

const MULTI_TEAM_HINT =
  "On more than one team? Your agent asks which team the project belongs to.";

interface PathCard {
  label: string;
  body: string;
  prompt: string;
  hue: string;
  labelColor: string;
}

/**
 * The two ways into a project, split across the brand gradient's ends:
 * clay for starting from nothing, sage for growing an existing repo.
 */
const PATH_CARDS: readonly PathCard[] = [
  {
    label: "Start new",
    body: "Describe what you're building.",
    prompt:
      "I want to build Poof, a to-do list where tasks vanish when they get no attention. Let's brainstorm together and create Poof",
    hue: "var(--color-accent)",
    labelColor: "var(--color-accent-light)",
  },
  {
    label: "Bring a repo",
    body: "Open your agent inside the repo and say:",
    prompt:
      "Onboard this codebase into Piyaz and ask me to clarify open points and future direction",
    hue: "var(--color-accent-2)",
    labelColor: "var(--color-accent-2)",
  },
];

interface FirstTimeBodyProps {
  /** Target-specific install snippets to render. */
  cliInstalls: readonly CliInstall[];
  /** Target-specific docs setup URL. */
  docsSetupUrl: string;
}

interface ReturningBodyProps {
  /** Target-specific docs setup URL. */
  docsSetupUrl: string;
}

/**
 * Select install snippets for the active deploy target.
 * @param deployTarget - Build-time deploy target exposed to client bundles.
 * @param origin - The self-host instance origin, substituted into every
 *   self-host endpoint so copied snippets point at the reader's own instance.
 *   Omitted during SSR and the hydration pass; {@link GetStartedGuide}
 *   supplies `window.location.origin` after mount to keep hydration stable.
 * @returns Hosted snippets for Cloudflare, otherwise self-host snippets.
 */
export function getCliInstalls(
  deployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "",
  origin?: string,
): readonly CliInstall[] {
  if (deployTarget === HOSTED_DEPLOY_TARGET) return HOSTED_CLI_INSTALLS;
  const endpoint = origin ? `${origin}/api/mcp` : DEFAULT_SELF_HOST_ENDPOINT;
  if (endpoint === DEFAULT_SELF_HOST_ENDPOINT) return SELF_HOST_CLI_INSTALLS;
  return SELF_HOST_CLI_INSTALLS.map((cli) => ({
    ...cli,
    install: cli.install.replaceAll(DEFAULT_SELF_HOST_ENDPOINT, endpoint),
  }));
}

/**
 * Select the docs setup URL for the active deploy target.
 * @param deployTarget - Build-time deploy target exposed to client bundles.
 * @returns Hosted or self-host docs setup URL.
 */
export function getDocsSetupUrl(
  deployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "",
): string {
  return deployTarget === HOSTED_DEPLOY_TARGET
    ? HOSTED_DOCS_SETUP_URL
    : SELF_HOST_DOCS_SETUP_URL;
}

interface PathCardsProps {
  /** @param invocation - Skill invocation prefix for the example prompts. */
  invocation?: string;
}

/**
 * The two ways into a project, start new or onboard an existing repo, as
 * side-by-side accent cards with the multi-team hint below.
 * @param props - Invocation prefix from the active harness tab.
 * @returns Path cards grid shared by both modal bodies.
 */
function PathCards({ invocation = "/piyaz" }: PathCardsProps) {
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {PATH_CARDS.map((card) => (
          <div
            key={card.label}
            className="relative overflow-hidden rounded-lg border p-3.5"
            style={{
              borderColor: `color-mix(in srgb, ${card.hue} 18%, var(--color-border))`,
              background: `color-mix(in srgb, ${card.hue} 5%, transparent)`,
            }}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-[2px]"
              style={{ background: card.hue }}
            />
            <div className="flex items-center justify-between gap-2">
              <h3
                className="font-mono text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: card.labelColor }}
              >
                {card.label}
              </h3>
              <CopyButton
                key={`${card.label}-${invocation}`}
                text={`${invocation} ${card.prompt}`}
              />
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              {card.body}
            </p>
            <p className="mt-2 font-mono text-xs leading-relaxed">
              <span className="text-text-faint">❯</span>{" "}
              <span
                className="font-semibold"
                style={{ color: card.labelColor }}
              >
                {invocation}
              </span>{" "}
              <span className="italic tracking-[0.002em] text-text-secondary">
                {card.prompt}
              </span>
            </p>
          </div>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-text-muted">
        {MULTI_TEAM_HINT}
      </p>
    </div>
  );
}

/**
 * First-run setup body: a tabbed install block for the four supported coding
 * agents, then the two project paths. The block takes each tab's natural
 * height with a small floor so short snippets still read as a code block.
 * @param props - Target-specific install copy.
 * @returns First-time install instructions.
 */
function FirstTimeBody({ cliInstalls, docsSetupUrl }: FirstTimeBodyProps) {
  const [activeCliName, setActiveCliName] = useState(cliInstalls[0].name);
  const activeCli =
    cliInstalls.find((cli) => cli.name === activeCliName) ?? cliInstalls[0];

  return (
    <>
      <section className="space-y-1.5">
        <h3 className={SECTION_LABEL_CLASS}>01 · Install for your tool</h3>
        <div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
          <div className="flex items-center justify-between gap-2 border-b border-border p-1.5">
            <div className="min-w-0 overflow-x-auto">
              <TabSwitcher
                tabs={cliInstalls.map((cli) => ({
                  id: cli.name,
                  label: cli.name,
                }))}
                activeTab={activeCli.name}
                onTabChange={setActiveCliName}
              />
            </div>
            <CopyButton
              key={activeCli.name}
              text={activeCli.install}
              className="shrink-0"
            />
          </div>
          <pre className="min-h-20 overflow-x-auto p-3 font-mono text-xs leading-relaxed text-text-primary">
            <code>{activeCli.install}</code>
          </pre>
          <div className="space-y-1 border-t border-border px-3 py-2">
            <p className="text-xs leading-relaxed text-text-muted">
              {activeCli.setupNote}
            </p>
            {activeCli.followUp ? (
              <p className="text-xs leading-relaxed text-text-muted">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                  {activeCli.followUp.label} ·{" "}
                </span>
                {activeCli.followUp.text}
              </p>
            ) : null}
            <p className="text-xs leading-relaxed text-text-muted">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                Verify ·{" "}
              </span>
              <span className="font-mono">
                <span className="text-text-faint">❯</span>{" "}
                <span className="font-semibold text-accent-light">
                  {activeCli.invocation}
                </span>{" "}
                <span className="italic tracking-[0.002em] text-text-secondary">
                  List my projects
                </span>
              </span>{" "}
              An empty list on a fresh account means the connection works.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-1.5">
        <h3 className={SECTION_LABEL_CLASS}>02 · Then tell your agent</h3>
        <PathCards invocation={activeCli.invocation} />
      </section>

      <p className="text-xs leading-relaxed text-text-muted">
        Full setup details (auth, updates, self-hosting) in the{" "}
        <a
          href={docsSetupUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          documentation
        </a>
        .
      </p>
    </>
  );
}

/**
 * No-op subscription for {@link useSyncExternalStore}; the origin never
 * changes within a page lifetime.
 * @returns Unsubscribe no-op.
 */
const emptySubscribe = () => () => {};

/**
 * Client snapshot for the instance origin.
 * @returns The browser's current origin.
 */
const readWindowOrigin = () => window.location.origin;

/**
 * Server snapshot for the instance origin.
 * @returns Undefined, keeping SSR and hydration on the default endpoint.
 */
const readServerOrigin = () => undefined;

/**
 * First-run setup guide: tabbed install block plus the two project paths.
 * Rendered inline on the zero-project home through FirstRunPanel. The
 * instance origin arrives via {@link useSyncExternalStore} so the SSR and
 * hydration passes render the same default-endpoint snippets.
 * @returns Guide sections for the active deploy target.
 */
export function GetStartedGuide() {
  const origin = useSyncExternalStore(
    emptySubscribe,
    readWindowOrigin,
    readServerOrigin,
  );

  return (
    <FirstTimeBody
      cliInstalls={getCliInstalls(undefined, origin)}
      docsSetupUrl={getDocsSetupUrl()}
    />
  );
}

/**
 * Body for users who already have at least one project — skips install
 * snippets and points them straight at their coding agent.
 * @param props - Target-specific setup link.
 * @returns Returning-user "go talk to your agent" hint.
 */
function ReturningBody({ docsSetupUrl }: ReturningBodyProps) {
  return (
    <>
      <p className="text-sm leading-relaxed text-text-secondary">
        Piyaz projects start in your coding agent, not here. Tell it what
        you&apos;re building, and the project shows up on this page once
        it&apos;s active.
      </p>

      <section className="space-y-1.5">
        <h3 className={SECTION_LABEL_CLASS}>Tell your agent</h3>
        <PathCards />
      </section>

      <p className="text-xs leading-relaxed text-text-muted">
        Setting up another tool, or starting from a fresh machine? Install
        commands live in the{" "}
        <a
          href={docsSetupUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          documentation
        </a>
        .
      </p>
    </>
  );
}

/**
 * Start-a-new-project dialog for users who already have projects — creation
 * happens in a coding agent, so the body points there with the path prompts.
 * First-run setup renders inline on the empty home through FirstRunPanel.
 * @param props - Modal configuration.
 * @returns Get-started modal rendered via {@link Modal}.
 */
export function GetStartedModal({ open, onClose }: GetStartedModalProps) {
  const docsSetupUrl = getDocsSetupUrl();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a new project"
      maxWidth="lg"
    >
      <div className="max-h-[80vh] space-y-5 overflow-y-auto pr-1">
        <ReturningBody docsSetupUrl={docsSetupUrl} />
      </div>
    </Modal>
  );
}

export default GetStartedModal;
