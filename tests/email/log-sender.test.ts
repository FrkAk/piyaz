import { test, expect, spyOn, afterEach } from "bun:test";
import { LogSender } from "@/lib/email/log-sender";
import type { EmailMessage } from "@/lib/email/types";

const sender = new LogSender();

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: "user@example.com",
  from: "noreply@piyaz.ai",
  subject: "Confirm your email",
  html: "<p>hi</p>",
  text: "hi",
  ...overrides,
});

/** Capture the single string `LogSender` passes to console.info. */
async function render(msg: EmailMessage): Promise<string> {
  const spy = spyOn(console, "info").mockImplementation(() => {});
  await sender.send(msg);
  return spy.mock.calls[0][0] as string;
}

/** The `- <url>` lines under the `URLs:` section, URLs only. */
const urlLines = (output: string): string[] =>
  output
    .split("\n")
    .filter((l) => l.startsWith("    - "))
    .map((l) => l.slice("    - ".length));

afterEach(() => {
  spyOn(console, "info").mockRestore();
});

test("trims trailing sentence punctuation from logged URLs", async () => {
  const output = await render(
    message({ text: "Confirm: https://app.piyaz.ai/verify?token=abc." }),
  );
  expect(urlLines(output)).toEqual(["https://app.piyaz.ai/verify?token=abc"]);
});

test("trims wrapping markup around logged URLs", async () => {
  const output = await render(
    message({ text: "Link (https://app.piyaz.ai/reset?token=xyz)" }),
  );
  expect(urlLines(output)).toEqual(["https://app.piyaz.ai/reset?token=xyz"]);
});

test("lists every URL in the body, one per line", async () => {
  const output = await render(
    message({
      text: "First https://a.example.com then https://b.example.com done",
    }),
  );
  expect(urlLines(output)).toEqual([
    "https://a.example.com",
    "https://b.example.com",
  ]);
});

test("renders the none-found marker when the body has no URLs", async () => {
  const output = await render(message({ text: "no links here" }));
  expect(output).toContain("URLs:     (none found)");
  expect(urlLines(output)).toEqual([]);
});

test("returns an ok result whose messageId carries the log- prefix", async () => {
  spyOn(console, "info").mockImplementation(() => {});
  const result = await sender.send(message());
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.messageId).toMatch(/^log-[0-9a-f-]{36}$/);
  }
});
