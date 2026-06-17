import { expect, test } from "bun:test";

interface CliInstall {
  name: string;
  install: string;
  setupNote: string;
}

interface GetStartedModalModule {
  getCliInstalls?: (deployTarget?: string) => readonly CliInstall[];
  getDocsSetupUrl?: (deployTarget?: string) => string;
}

/**
 * Load the modal module through the public alias used by the app.
 *
 * @returns The install-data selectors exported by the modal module.
 */
async function loadGetStartedModalModule(): Promise<{
  getCliInstalls: NonNullable<GetStartedModalModule["getCliInstalls"]>;
  getDocsSetupUrl: NonNullable<GetStartedModalModule["getDocsSetupUrl"]>;
}> {
  const modal = (await import(
    "@/components/home/GetStartedModal"
  )) as GetStartedModalModule;

  expect(typeof modal.getCliInstalls).toBe("function");
  expect(typeof modal.getDocsSetupUrl).toBe("function");
  return {
    getCliInstalls: modal.getCliInstalls as NonNullable<
      GetStartedModalModule["getCliInstalls"]
    >,
    getDocsSetupUrl: modal.getDocsSetupUrl as NonNullable<
      GetStartedModalModule["getDocsSetupUrl"]
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
  const { getCliInstalls, getDocsSetupUrl } =
    await loadGetStartedModalModule();
  const installs = getCliInstalls("cloudflare");
  const text = installText(installs);

  expect(installs.map((cli) => cli.name)).toEqual([
    "Claude Code",
    "Codex",
    "Antigravity",
    "Cursor",
  ]);
  expect(text).toContain("claude plugin marketplace add FrkAk/piyaz");
  expect(text).toContain("claude plugin install piyaz@piyaz");
  expect(text).toContain("codex plugin marketplace add FrkAk/piyaz");
  expect(text).toContain("https://app.piyaz.ai/api/mcp");
  expect(text).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
  expect(text).not.toContain("./plugins");
  expect(text).not.toContain("localhost");
  expect(text).not.toContain("piyaz-local");
  expect(getDocsSetupUrl("cloudflare")).toContain(
    "docs.piyaz.ai/docs/get-started/install",
  );
});

test("self-host deploy keeps local plugin install commands", async () => {
  const { getCliInstalls, getDocsSetupUrl } =
    await loadGetStartedModalModule();
  const installs = getCliInstalls("");
  const text = installText(installs);

  expect(text).toContain("./plugins/claude-code");
  expect(text).toContain("codex plugin marketplace add ./plugins");
  expect(text).toContain("./plugins/antigravity");
  expect(text).toContain("plugins/cursor");
  expect(text).toContain("piyaz-local");
  expect(text).toContain("localhost");
  expect(text).not.toContain("FrkAk/piyaz");
  expect(getDocsSetupUrl("")).toContain("docs.piyaz.ai/docs/guides/self-host");
});
