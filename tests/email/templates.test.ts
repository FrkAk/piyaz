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
  emailChangeApprovalEmail,
  passwordChangedEmail,
  newSignInEmail,
  deleteAccountEmail,
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
        expiresLabel: "1 hour",
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
        expiresLabel: "1 hour",
      }),
  ],
  [
    "passwordChanged",
    (b: BrandConfig) =>
      passwordChangedEmail(b, {
        recipientName: "Dana",
        timestamp: "2026-07-10 18:00 UTC",
        device: "Firefox on Linux",
        location: "Berlin, DE (203.0.113.7)",
      }),
  ],
  [
    "newSignIn",
    (b: BrandConfig) =>
      newSignInEmail(b, {
        timestamp: "2026-07-10 18:00 UTC",
        device: "Firefox on Linux",
        location: "Berlin, DE (203.0.113.7)",
      }),
  ],
  [
    "emailChangeApproval",
    (b: BrandConfig) =>
      emailChangeApprovalEmail(b, {
        approveUrl: "https://app.example/approve?t=abc",
        newEmail: "new@acme.example",
        recipientName: "Dana",
        expiresLabel: "1 hour",
      }),
  ],
  [
    "deleteAccount",
    (b: BrandConfig) =>
      deleteAccountEmail(b, {
        confirmUrl: "https://app.example/delete?t=abc",
        expiresLabel: "24 hours",
        recipientName: "Dana",
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
    expect(withSupport.text).toContain(
      "If this wasn't you, contact help@acme.example right away to secure your account.",
    );
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

  test("verification expiry note renders only when expiresLabel is set", () => {
    const without = verificationEmail(neutral, {
      verifyUrl: "https://app.example/v",
    });
    expect(without.html).not.toContain("This link expires");
    expect(without.text).not.toContain("This link expires");
    const withLabel = verificationEmail(neutral, {
      verifyUrl: "https://app.example/v",
      expiresLabel: "1 hour",
    });
    expect(withLabel.html).toContain("This link expires in 1 hour.");
    expect(withLabel.text).toContain("This link expires in 1 hour.");
  });

  test("passwordReset always carries the single-use line", () => {
    const without = passwordResetEmail(neutral, {
      resetUrl: "https://app.example/r",
    });
    expect(without.html).toContain("This link can only be used once.");
    expect(without.text).toContain("This link can only be used once.");
    const withLabel = passwordResetEmail(neutral, {
      resetUrl: "https://app.example/r",
      expiresLabel: "1 hour",
    });
    expect(withLabel.html).toContain("This link can only be used once.");
    expect(withLabel.text).toContain("This link can only be used once.");
  });

  test("emailChange expiry note renders only when expiresLabel is set", () => {
    const without = emailChangeEmail(neutral, {
      confirmUrl: "https://app.example/change?t=abc",
      newEmail: "new@acme.example",
    });
    expect(without.html).not.toContain("This link expires");
    expect(without.text).not.toContain("This link expires");
    const withLabel = emailChangeEmail(neutral, {
      confirmUrl: "https://app.example/change?t=abc",
      newEmail: "new@acme.example",
      expiresLabel: "1 hour",
    });
    expect(withLabel.html).toContain("This link expires in 1 hour.");
    expect(withLabel.text).toContain("This link expires in 1 hour.");
  });

  test("emailChangeApproval expiry note renders only when expiresLabel is set", () => {
    const without = emailChangeApprovalEmail(neutral, {
      approveUrl: "https://app.example/approve?t=abc",
      newEmail: "new@acme.example",
    });
    expect(without.html).not.toContain("This link expires");
    expect(without.text).not.toContain("This link expires");
    const withLabel = emailChangeApprovalEmail(neutral, {
      approveUrl: "https://app.example/approve?t=abc",
      newEmail: "new@acme.example",
      expiresLabel: "1 hour",
    });
    expect(withLabel.html).toContain("This link expires in 1 hour.");
    expect(withLabel.text).toContain("This link expires in 1 hour.");
  });

  test("passwordChanged renders When/Device/Location notes only when set", () => {
    const withContext = passwordChangedEmail(neutral, {
      timestamp: "2026-07-10 18:00 UTC",
      device: "Firefox on Linux",
      location: "Berlin, DE (203.0.113.7)",
    });
    expect(withContext.text).toContain("When: 2026-07-10 18:00 UTC");
    expect(withContext.text).toContain("Device: Firefox on Linux");
    expect(withContext.text).toContain("Location: Berlin, DE (203.0.113.7)");
    const withoutContext = passwordChangedEmail(neutral, {});
    expect(withoutContext.text).not.toContain("When:");
    expect(withoutContext.text).not.toContain("Device:");
    expect(withoutContext.text).not.toContain("Location:");
  });

  test("newSignIn renders a Location note when set", () => {
    const { html, text } = newSignInEmail(neutral, {
      location: "Berlin, DE (203.0.113.7)",
    });
    expect(html).toContain("Location: Berlin, DE (203.0.113.7)");
    expect(text).toContain("Location: Berlin, DE (203.0.113.7)");
  });

  test("emailChangeApproval names the new address; wasn't-you copy gated on supportEmail", () => {
    const withSupport = emailChangeApprovalEmail(branded, {
      approveUrl: "https://app.example/approve?t=abc",
      newEmail: "new@acme.example",
    });
    expect(withSupport.html).toContain("new@acme.example");
    expect(withSupport.text).toContain("new@acme.example");
    expect(withSupport.text).toMatch(
      /\nhttps:\/\/app\.example\/approve\?t=abc\n/,
    );
    expect(withSupport.text).toContain(
      "If you didn't request this change, don't approve it. Contact help@acme.example right away to secure your account.",
    );
    const withoutSupport = emailChangeApprovalEmail(neutral, {
      approveUrl: "https://app.example/approve?t=abc",
      newEmail: "new@acme.example",
    });
    expect(withoutSupport.text).not.toContain("help@acme.example");
    expect(withoutSupport.text).toContain(
      "If you didn't request this change, don't approve it. Change your password right away to secure your account.",
    );
  });

  test("deleteAccount renders its confirm URL, gated expiry note, and didn't-request line", () => {
    const without = deleteAccountEmail(neutral, {
      confirmUrl: "https://app.example/delete?t=abc",
    });
    expect(without.text).toMatch(/\nhttps:\/\/app\.example\/delete\?t=abc\n/);
    expect(without.html).not.toContain("This link expires");
    expect(without.text).not.toContain("This link expires");
    expect(without.text).toContain("your account will stay active");
    const withLabel = deleteAccountEmail(neutral, {
      confirmUrl: "https://app.example/delete?t=abc",
      expiresLabel: "24 hours",
    });
    expect(withLabel.html).toContain("This link expires in 24 hours.");
    expect(withLabel.text).toContain("This link expires in 24 hours.");
    expect(withLabel.text).toContain("your account will stay active");
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

  test("newline-smuggling location and timestamp cannot forge text lines", () => {
    const signIn = newSignInEmail(neutral, {
      timestamp: "18:00\nUrgent: verify at https://evil.example",
      location: "203.0.113.7\n\nYour account is locked, call now",
    });
    expect(signIn.text).not.toContain("\nUrgent:");
    expect(signIn.text).not.toContain("\nYour account is locked");
    expect(signIn.text).not.toContain("\nhttps://evil.example");
    const changed = passwordChangedEmail(neutral, {
      timestamp: "18:00\nUrgent: verify at https://evil.example",
      location: "203.0.113.7\n\nYour account is locked, call now",
    });
    expect(changed.text).not.toContain("\nUrgent:");
    expect(changed.text).not.toContain("\nYour account is locked");
    expect(changed.text).not.toContain("\nhttps://evil.example");
  });

  test("a hostile newEmail cannot break out of markup or forge text lines", () => {
    const breakout = emailChangeApprovalEmail(neutral, {
      approveUrl: "https://app.example/approve",
      newEmail: 'evil@x"><img src=x>',
    });
    expect(breakout.html).not.toContain('"><img');
    expect(breakout.html).not.toContain("<img src=x>");
    const smuggled = emailChangeApprovalEmail(neutral, {
      approveUrl: "https://app.example/approve",
      newEmail: "evil@x\nYour account is locked, call now",
    });
    expect(smuggled.text).not.toContain("\nYour account is locked");
  });

  test("hostile approve and confirm URLs degrade to dead labels", () => {
    const approval = emailChangeApprovalEmail(neutral, {
      approveUrl: "javascript:alert(1)",
      newEmail: "new@acme.example",
    });
    expect(approval.html).not.toContain("javascript:");
    expect(approval.html).toContain("Approve email change");
    expect(approval.text).not.toContain("javascript:");
    const deletion = deleteAccountEmail(neutral, {
      confirmUrl: "javascript:alert(1)",
    });
    expect(deletion.html).not.toContain("javascript:");
    expect(deletion.html).toContain("Confirm account deletion");
    expect(deletion.text).not.toContain("javascript:");
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
