"use client";

import { Modal } from "@/components/shared/Modal";
import { CopyButton } from "@/components/shared/CopyButton";

interface GetStartedModalProps {
  /** @param open - Whether the modal is visible. */
  open: boolean;
  /** @param onClose - Called when the modal requests dismissal. */
  onClose: () => void;
  /** @param hasProjects - True when the user already owns ≥1 project. Switches to the returning-user view. */
  hasProjects?: boolean;
}

interface CliInstall {
  name: string;
  install: string;
  setupNote: string;
}

const HOSTED_DEPLOY_TARGET = "cloudflare";

const HOSTED_CLI_INSTALLS: readonly CliInstall[] = [
  {
    name: "Claude Code",
    install:
      "claude plugin marketplace add FrkAk/mymir\nclaude plugin install mymir@mymir",
    setupNote:
      "Run /mcp, select mymir, and complete the browser sign-in. The mymir skill auto-invokes when you talk about projects.",
  },
  {
    name: "Codex",
    install: "codex plugin marketplace add FrkAk/mymir",
    setupNote:
      "Run /plugin, install Mymir, restart Codex, and authenticate when prompted. Invoke the main skill with $mymir.",
  },
  {
    name: "Antigravity",
    install:
      '{\n  "mcpServers": {\n    "mymir": { "serverUrl": "https://app.mymir.dev/api/mcp" }\n  }\n}',
    setupNote:
      "Add this to your global MCP config, then run /mcp and Authenticate. Antigravity handles OAuth automatically.",
  },
  {
    name: "Cursor",
    install:
      "cursor://anysphere.cursor-deeplink/mcp/install?name=mymir&config=eyJ1cmwiOiJodHRwczovL2FwcC5teW1pci5kZXYvYXBpL21jcCJ9",
    setupNote:
      "Open the deeplink, then sign in when the first Mymir MCP tool call triggers OAuth.",
  },
];

const SELF_HOST_CLI_INSTALLS: readonly CliInstall[] = [
  {
    name: "Claude Code",
    install:
      "claude plugin marketplace add ./plugins/claude-code\nclaude plugin install mymir@mymir-local",
    setupNote:
      "Authenticate with /mcp, select mymir-local, and complete the browser sign-in against http://localhost:3000.",
  },
  {
    name: "Codex",
    install: "codex plugin marketplace add ./plugins",
    setupNote:
      "Run /plugin, search for mymir, install, then restart Codex. Select mymir-local for http://localhost:3000/api/mcp.",
  },
  {
    name: "Antigravity",
    install: "agy plugin install ./plugins/antigravity",
    setupNote:
      "Run /mcp, select mymir-local, Authenticate, and complete the browser sign-in against http://localhost:3000.",
  },
  {
    name: "Cursor",
    install: 'ln -s "$(pwd)/plugins/cursor" ~/.cursor/plugins/local/mymir',
    setupNote:
      "Restart Cursor. The MCP server and skills load automatically; mymir-local points at http://localhost:3000/api/mcp.",
  },
];

const HOSTED_README_SETUP_URL =
  "https://github.com/FrkAk/mymir#use-the-hosted-version-no-clone";
const SELF_HOST_README_SETUP_URL =
  "https://github.com/FrkAk/mymir#self-host-contribute";

const SECTION_LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted";

const MULTI_TEAM_HINT =
  "If you belong to more than one team, your coding agent will ask which team a new project belongs to before creating it.";

interface FirstTimeBodyProps {
  /** @param cliInstalls - Target-specific install snippets to render. */
  cliInstalls: readonly CliInstall[];
  /** @param readmeSetupUrl - Target-specific README setup anchor. */
  readmeSetupUrl: string;
}

interface ReturningBodyProps {
  /** @param readmeSetupUrl - Target-specific README setup anchor. */
  readmeSetupUrl: string;
}

/**
 * Select install snippets for the active deploy target.
 * @param deployTarget - Build-time deploy target exposed to client bundles.
 * @returns Hosted snippets for Cloudflare, otherwise self-host snippets.
 */
export function getCliInstalls(
  deployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "",
): readonly CliInstall[] {
  return deployTarget === HOSTED_DEPLOY_TARGET
    ? HOSTED_CLI_INSTALLS
    : SELF_HOST_CLI_INSTALLS;
}

/**
 * Select the setup guide anchor for the active deploy target.
 * @param deployTarget - Build-time deploy target exposed to client bundles.
 * @returns Hosted or self-host README setup URL.
 */
export function getReadmeSetupUrl(
  deployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "",
): string {
  return deployTarget === HOSTED_DEPLOY_TARGET
    ? HOSTED_README_SETUP_URL
    : SELF_HOST_README_SETUP_URL;
}

/**
 * Body for users who haven't created a project yet — emphasizes plugin
 * install commands across the four supported coding agents.
 * @param props - Target-specific install copy.
 * @returns First-time install instructions.
 */
function FirstTimeBody({ cliInstalls, readmeSetupUrl }: FirstTimeBodyProps) {
  return (
    <>
      <p className="text-sm leading-relaxed text-text-secondary">
        mymir runs in your coding agent, which has the file context an in-app
        chat never will. Install or configure Mymir for your tool, then describe
        what you&apos;re building.
      </p>

      <ol className="space-y-4">
        {cliInstalls.map((cli) => (
          <li key={cli.name} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <h3 className={SECTION_LABEL_CLASS}>{cli.name}</h3>
              <CopyButton text={cli.install} />
            </div>
            <pre className="overflow-x-auto rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs leading-relaxed text-text-primary">
              <code>{cli.install}</code>
            </pre>
            <p className="text-xs leading-relaxed text-text-muted">
              {cli.setupNote}
            </p>
          </li>
        ))}
      </ol>

      <section className="space-y-1.5 rounded-lg border border-accent/20 bg-accent/[0.04] p-4">
        <h3 className={SECTION_LABEL_CLASS}>Then say something like</h3>
        <p className="font-mono text-xs leading-relaxed text-text-primary">
          ❯ Describe what you are building. The mymir skill picks up from there.
        </p>
        <p className="text-xs leading-relaxed text-text-muted">
          {MULTI_TEAM_HINT}
        </p>
      </section>

      <p className="text-xs leading-relaxed text-text-muted">
        Full setup details (auth, updates, self-hosting) in the{" "}
        <a
          href={readmeSetupUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          project README
        </a>
        .
      </p>
    </>
  );
}

/**
 * Body for users who already have at least one project — skips install
 * snippets and points them straight at their coding agent.
 * @param props - Target-specific setup link.
 * @returns Returning-user "go talk to your agent" hint.
 */
function ReturningBody({ readmeSetupUrl }: ReturningBodyProps) {
  return (
    <>
      <p className="text-sm leading-relaxed text-text-secondary">
        mymir projects start in your coding agent. Open it and describe what
        you&apos;re building. The mymir skill creates the project, and
        it&apos;ll show up here once it&apos;s active.
      </p>

      <section className="space-y-1.5 rounded-lg border border-accent/20 bg-accent/[0.04] p-4">
        <h3 className={SECTION_LABEL_CLASS}>For example</h3>
        <p className="font-mono text-xs leading-relaxed text-text-primary">
          ❯ I want to build a real-time dashboard for server metrics
        </p>
        <p className="text-xs leading-relaxed text-text-muted">
          {MULTI_TEAM_HINT}
        </p>
      </section>

      <p className="text-xs leading-relaxed text-text-muted">
        Setting up another tool, or starting from a fresh machine? Install
        commands live in the{" "}
        <a
          href={readmeSetupUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          project README
        </a>
        .
      </p>
    </>
  );
}

/**
 * Get-started dialog — projects are created from a coding agent, not the web app.
 * Adapts to user state: first-time users see plugin install commands, returning
 * users see a tight pointer back to their agent.
 * @param props - Modal configuration.
 * @returns Get-started modal rendered via {@link Modal}.
 */
export function GetStartedModal({
  open,
  onClose,
  hasProjects = false,
}: GetStartedModalProps) {
  const deployTarget = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  const cliInstalls = getCliInstalls(deployTarget);
  const readmeSetupUrl = getReadmeSetupUrl(deployTarget);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={hasProjects ? "Start a new project" : "Get started"}
      maxWidth="lg"
    >
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        {hasProjects ? (
          <ReturningBody readmeSetupUrl={readmeSetupUrl} />
        ) : (
          <FirstTimeBody
            cliInstalls={cliInstalls}
            readmeSetupUrl={readmeSetupUrl}
          />
        )}
      </div>
    </Modal>
  );
}

export default GetStartedModal;
