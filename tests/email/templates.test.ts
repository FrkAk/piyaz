import { test, expect, describe } from "bun:test";
import type { BrandConfig } from "@/lib/email/types";
import {
  escapeHtml,
  safeUrl,
  safeBrandColor,
} from "@/lib/email/templates/render";
import {
  verificationEmail,
  passwordResetEmail,
  emailChangeEmail,
  passwordChangedEmail,
  newSignInEmail,
} from "@/lib/email/templates";

const neutral: BrandConfig = {
  appName: "tasks.acme.example",
  appUrl: "https://tasks.acme.example",
};

const branded: BrandConfig = {
  appName: "Acme Tasks",
  appUrl: "https://tasks.acme.example",
  logoUrl: "https://cdn.acme.example/logo.png",
  brandColor: "#123456",
  footerLinks: [
    { label: "Home", url: "https://acme.example" },
    { label: "Support", url: "mailto:help@acme.example" },
  ],
  supportEmail: "help@acme.example",
};

const samples = [
  [
    "verification",
    (b: BrandConfig) =>
      verificationEmail(b, {
        verifyUrl: "https://app.example/verify?t=abc",
        recipientName: "Dana",
      }),
  ],
  [
    "passwordReset",
    (b: BrandConfig) =>
      passwordResetEmail(b, {
        resetUrl: "https://app.example/reset?t=abc",
        expiresLabel: "1 hour",
      }),
  ],
  [
    "emailChange",
    (b: BrandConfig) =>
      emailChangeEmail(b, {
        confirmUrl: "https://app.example/change?t=abc",
        newEmail: "new@acme.example",
      }),
  ],
  [
    "passwordChanged",
    (b: BrandConfig) => passwordChangedEmail(b, { recipientName: "Dana" }),
  ],
  [
    "newSignIn",
    (b: BrandConfig) =>
      newSignInEmail(b, {
        timestamp: "2026-07-10 18:00 UTC",
        device: "Firefox on Linux",
      }),
  ],
] as const;

describe("sanitizers", () => {
  test("escapeHtml neutralizes the five significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });

  test("safeUrl accepts allowed schemes and rejects everything else", () => {
    expect(safeUrl("https://ok.example/p", ["https:"])).toBe(
      "https://ok.example/p",
    );
    expect(safeUrl("mailto:a@b.com", ["https:", "mailto:"])).toBe(
      "mailto:a@b.com",
    );
    expect(safeUrl("http://ok.example", ["https:"])).toBeUndefined();
    expect(safeUrl("javascript:alert(1)", ["https:"])).toBeUndefined();
    expect(safeUrl("data:text/html,x", ["https:"])).toBeUndefined();
    expect(safeUrl("//host/path", ["https:"])).toBeUndefined();
    expect(safeUrl("/relative", ["https:"])).toBeUndefined();
    expect(safeUrl("not a url", ["https:"])).toBeUndefined();
  });

  test("safeUrl rejects URLs carrying whitespace or control characters", () => {
    expect(
      safeUrl("https://ok.example/a\n\ninjected", ["https:"]),
    ).toBeUndefined();
    expect(safeUrl("https://ok.\texample/p", ["https:"])).toBeUndefined();
    expect(safeUrl("https://ok.example/\rp", ["https:"])).toBeUndefined();
  });

  test("safeBrandColor accepts 3/6-digit hex and rejects everything else", () => {
    expect(safeBrandColor("#123")).toBe("#123");
    expect(safeBrandColor("#123456")).toBe("#123456");
    expect(safeBrandColor("#12345678")).toBeUndefined();
    expect(safeBrandColor("rgb(10, 20, 30)")).toBeUndefined();
    expect(safeBrandColor("hsla(200 50% 40% / 0.5)")).toBeUndefined();
    expect(safeBrandColor("red")).toBeUndefined();
    expect(safeBrandColor("#12")).toBeUndefined();
    expect(safeBrandColor("red;} body{background:url(x)}")).toBeUndefined();
    expect(safeBrandColor('#fff" onload="x')).toBeUndefined();
    expect(safeBrandColor("expression(alert(1))")).toBeUndefined();
  });
});

describe("template structure", () => {
  for (const [name, make] of samples) {
    test(`${name} returns matched non-empty html and text`, () => {
      const { html, text } = make(branded);
      expect(html.length).toBeGreaterThan(0);
      expect(text.length).toBeGreaterThan(0);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(text).toContain(branded.appName);
    });

    test(`${name} html carries the client-robust layout structure`, () => {
      const { html } = make(branded);
      expect(html).toContain('role="presentation"');
      expect(html).toContain("max-width:600px");
      expect(html).toContain('name="color-scheme"');
      expect(html).toContain("<h1");
    });
  }

  test("branded output renders the logo with escaped alt text and surviving footer links", () => {
    const { html } = verificationEmail(branded, {
      verifyUrl: "https://app.example/v",
    });
    expect(html).toContain(`src="https://cdn.acme.example/logo.png"`);
    expect(html).toContain(`alt="Acme Tasks"`);
    expect(html).toContain("https://acme.example");
    expect(html).toContain("mailto:help@acme.example");
    expect(html).toContain("#123456");
  });

  test("neutral output carries no logo image, no brand color, and no piyaz.ai", () => {
    const { html, text } = verificationEmail(neutral, {
      verifyUrl: "https://app.example/v",
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("#1f2937");
    expect(html).not.toContain("piyaz.ai");
    expect(text).not.toContain("piyaz.ai");
  });

  test("passwordChanged has no action link; support pointer gated on supportEmail", () => {
    const withSupport = passwordChangedEmail(branded, {});
    expect(withSupport.html).not.toContain("color:#ffffff");
    expect(withSupport.text).not.toContain("Confirm email:");
    expect(withSupport.text).toContain("help@acme.example");
    const withoutSupport = passwordChangedEmail(neutral, {});
    expect(withoutSupport.text).not.toContain("help@acme.example");
    expect(withoutSupport.text).toContain("reset your password");
  });

  test("action URLs appear on their own line in the text part", () => {
    const { text } = verificationEmail(neutral, {
      verifyUrl: "https://app.example/verify?t=abc",
    });
    expect(text).toMatch(/\nhttps:\/\/app\.example\/verify\?t=abc\n/);
  });

  test("http action URLs survive for local-dev links", () => {
    const { text } = verificationEmail(neutral, {
      verifyUrl: "http://localhost:3000/verify?t=abc",
    });
    expect(text).toMatch(/\nhttp:\/\/localhost:3000\/verify\?t=abc\n/);
  });

  test("button label color follows the accent's luminance", () => {
    const light = verificationEmail(
      { ...neutral, brandColor: "#ffee00" },
      { verifyUrl: "https://app.example/v" },
    );
    expect(light.html).toContain("background:#ffee00");
    expect(light.html).toContain("color:#111827;text-decoration:none");
    const dark = verificationEmail(branded, {
      verifyUrl: "https://app.example/v",
    });
    expect(dark.html).toContain("color:#ffffff;text-decoration:none");
  });
});

describe("hostile input is neutralized (AC #4)", () => {
  const hostile: BrandConfig = {
    appName: "Acme <script>alert(1)</script>",
    appUrl: "https://tasks.acme.example",
    logoUrl: "javascript:alert(1)",
    brandColor: "red;} body{background:url(x)}",
    footerLinks: [
      { label: 'Evil"><img src=x>', url: "javascript:alert(2)" },
      { label: 'Home"><b>', url: "https://ok.example" },
    ],
    supportEmail: "help@acme.example",
  };

  test("no hostile logo, script, color injection, or footer scheme survives", () => {
    const { html } = verificationEmail(hostile, {
      verifyUrl: "https://app.example/v",
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("background:url(x)");
    expect(html).not.toContain("red;}");
    expect(html).toContain("#1f2937");
    expect(html).not.toContain('"><img');
    expect(html).not.toContain('"><b>');
    expect(html).toContain("https://ok.example");
  });

  test("a hostile action URL degrades to its label with no live link", () => {
    const { html, text } = verificationEmail(neutral, {
      verifyUrl: "javascript:alert(1)",
    });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Confirm email");
    expect(text).not.toContain("javascript:");
  });

  test("an action URL smuggling newlines degrades instead of injecting text lines", () => {
    const { html, text } = verificationEmail(neutral, {
      verifyUrl: "https://app.example/v\n\nYour account is locked, call now",
    });
    expect(html).not.toContain("call now");
    expect(text).not.toContain("call now");
  });

  test("params smuggling newlines cannot forge lines in the text part", () => {
    const { text } = newSignInEmail(neutral, {
      recipientName: "Dana\nYour account is locked, call now",
      device: "Firefox\n\nYour session expired: https://evil.example",
    });
    expect(text).not.toContain("\nYour account is locked");
    expect(text).not.toContain("\nYour session expired");
    expect(text).not.toContain("\nhttps://evil.example");
  });

  test("footer labels and appName smuggling newlines cannot forge text lines", () => {
    const { text } = verificationEmail(
      {
        appName: "Acme\nUrgent: verify at https://evil.example",
        appUrl: "https://tasks.acme.example",
        footerLinks: [
          {
            label: "Help\nSign in: https://evil.example",
            url: "https://ok.example",
          },
        ],
      },
      { verifyUrl: "https://app.example/v" },
    );
    expect(text).not.toContain("\nUrgent:");
    expect(text).not.toContain("\nSign in:");
    expect(text).not.toContain("\nhttps://evil.example");
  });
});

describe("branded vs neutral snapshots (AC #2)", () => {
  for (const [name, make] of samples) {
    test(`${name} branded`, () => {
      expect(make(branded).html).toMatchSnapshot();
    });
    test(`${name} neutral`, () => {
      expect(make(neutral).html).toMatchSnapshot();
    });
  }
});
