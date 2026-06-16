import { expect, test } from "bun:test";

interface CliInstall {
  name: string;
  install: string;
  setupNote: string;
}

interface GetStartedModalModule {
  getCliInstalls?: (deployTarget?: string) => readonly CliInstall[];
  getReadmeSetupUrl?: (deployTarget?: string) => string;
}

/**
 * Load the modal module through the public alias used by the app.
 *
 * @returns The install-data selectors exported by the modal module.
 */
async function loadGetStartedModalModule(): Promise<{
  getCliInstalls: NonNullable<GetStartedModalModule["getCliInstalls"]>;
  getReadmeSetupUrl: NonNullable<GetStartedModalModule["getReadmeSetupUrl"]>;
}> {
  const modal = (await import(
    "@/components/home/GetStartedModal"
  )) as GetStartedModalModule;

  expect(typeof modal.getCliInstalls).toBe("function");
  expect(typeof modal.getReadmeSetupUrl).toBe("function");
  return {
    getCliInstalls: modal.getCliInstalls as NonNullable<
      GetStartedModalModule["getCliInstalls"]
    >,
    getReadmeSetupUrl: modal.getReadmeSetupUrl as NonNullable<
      GetStartedModalModule["getReadmeSetupUrl"]
    >,
  };
}

/**
 * Flatten install snippets for substring assertions.
 *
 * @param installs - CLI install entries under test.
 * @returns Combined command and setup-note text.
 */
function installText(installs: readonly CliInstall[]): string {
  return installs.map((cli) => `${cli.install}\n${cli.setupNote}`).join("\n");
}

test("hosted deploy shows hosted setup snippets without local checkout paths", async () => {
  const { getCliInstalls, getReadmeSetupUrl } =
    await loadGetStartedModalModule();
  const installs = getCliInstalls("cloudflare");
  const text = installText(installs);

  expect(installs.map((cli) => cli.name)).toEqual([
    "Claude Code",
    "Codex",
    "Antigravity",
    "Cursor",
  ]);
  expect(text).toContain("claude plugin marketplace add FrkAk/mymir");
  expect(text).toContain("claude plugin install piyaz@piyaz");
  expect(text).toContain("codex plugin marketplace add FrkAk/mymir");
  expect(text).toContain("https://app.piyaz.ai/api/mcp");
  expect(text).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
  expect(text).not.toContain("./plugins");
  expect(text).not.toContain("localhost");
  expect(text).not.toContain("piyaz-local");
  expect(getReadmeSetupUrl("cloudflare")).toContain(
    "#use-the-hosted-version-no-clone",
  );
});

test("self-host deploy keeps local plugin install commands", async () => {
  const { getCliInstalls, getReadmeSetupUrl } =
    await loadGetStartedModalModule();
  const installs = getCliInstalls("");
  const text = installText(installs);

  expect(text).toContain("./plugins/claude-code");
  expect(text).toContain("codex plugin marketplace add ./plugins");
  expect(text).toContain("./plugins/antigravity");
  expect(text).toContain("plugins/cursor");
  expect(text).toContain("piyaz-local");
  expect(text).toContain("localhost");
  expect(text).not.toContain("FrkAk/mymir");
  expect(getReadmeSetupUrl("")).toContain("#self-host-contribute");
});
