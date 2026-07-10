/**
 * Security and layout core for the transactional email templates. Every value
 * that reaches an email is untrusted: `BrandConfig` carries `logoUrl`,
 * `brandColor`, and `footerLinks[].url` through from env UNVALIDATED by design
 * (see `resolveBrandConfig` in `lib/email/brand.ts`), and per-email params come
 * from callers. This module is the sole defense: every interpolated value is
 * HTML-escaped, URLs are scheme-validated before use, and `brandColor` is
 * accepted only against a strict pattern. All sanitizers are non-throwing, so a
 * hostile value degrades to neutral output rather than crashing a send.
 *
 * Pure string builders with a single import of the shared type: no
 * `server-only`, no `process.env`, so templates stay unit-testable and compile
 * identically into the Node and Workers bundles.
 */
import type { BrandConfig } from "../types";

/**
 * Escape the five HTML-significant characters. Used for every interpolated
 * value in both text and attribute contexts, so a payload carrying quotes or
 * angle brackets cannot break out of the surrounding markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Return `raw` only when it parses as an absolute URL whose scheme is allowed
 * (`allow` holds protocol strings with the trailing colon, e.g. `"https:"`).
 * Rejects `javascript:`/`data:` (disallowed scheme), protocol-relative and
 * relative URLs (no base, so `new URL` throws), and any unparseable value.
 * Callers still HTML-escape the result before placing it in `href`/`src`.
 */
export function safeUrl(
  raw: string,
  allow: readonly string[],
): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return allow.includes(url.protocol) ? raw : undefined;
}

const HEX_COLOR =
  /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})$/;
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%/\s]+\)$/;

/**
 * Return `raw` only when it is a strict CSS color: a 3/4/6/8-digit hex, or an
 * `rgb`/`rgba`/`hsl`/`hsla` function whose arguments are numeric, percent,
 * comma, slash, or whitespace only. Anything carrying `;`, `}`, quotes, angle
 * brackets, `url(`, or `expression(` fails the pattern and degrades to the
 * neutral accent, so a `brandColor` cannot inject into the `style` attribute.
 */
export function safeBrandColor(raw: string): string | undefined {
  const value = raw.trim();
  if (HEX_COLOR.test(value) || FUNC_COLOR.test(value)) return value;
  return undefined;
}

/** A tappable primary action rendered as a button in HTML and a labeled URL in text. */
export interface EmailAction {
  label: string;
  url: string;
}

/** One content block. Templates compose an ordered list of these; the shell renders them. */
export type EmailBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "action"; label: string; url: string }
  | { kind: "note"; text: string };

/** The body a template hands to the shell. `preheader` is the hidden inbox-preview line. */
export interface EmailContent {
  preheader?: string;
  heading: string;
  blocks: EmailBlock[];
}

const PAGE_BG = "#f4f4f5";
const CONTAINER_BG = "#ffffff";
const TEXT = "#111827";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";
const NEUTRAL_ACCENT = "#1f2937";
const ACTION_SCHEMES = ["https:"] as const;
const LOGO_SCHEMES = ["https:"] as const;
const FOOTER_SCHEMES = ["https:", "mailto:"] as const;
const APP_URL_SCHEMES = ["https:", "http:"] as const;

/** Resolve the accent color for buttons, falling back to the neutral default on any unsafe value. */
function accentColor(brand: BrandConfig): string {
  const safe = brand.brandColor ? safeBrandColor(brand.brandColor) : undefined;
  return safe ?? NEUTRAL_ACCENT;
}

/** Footer links whose URL passes the https/mailto scheme check; invalid links are dropped individually. */
function safeFooterLinks(brand: BrandConfig): { label: string; url: string }[] {
  return (brand.footerLinks ?? []).flatMap((link) => {
    const url = safeUrl(link.url, FOOTER_SCHEMES);
    return url ? [{ label: link.label, url }] : [];
  });
}

function renderHeader(brand: BrandConfig): string {
  const name = escapeHtml(brand.appName);
  const logo = brand.logoUrl ? safeUrl(brand.logoUrl, LOGO_SCHEMES) : undefined;
  const inner = logo
    ? `<img src="${escapeHtml(logo)}" alt="${name}" height="32" style="height:32px;max-width:180px;border:0;display:block;" />`
    : `<span style="font-size:18px;font-weight:700;color:${TEXT};">${name}</span>`;
  return `<td style="padding:24px 32px;border-bottom:1px solid ${BORDER};">${inner}</td>`;
}

function renderBlock(block: EmailBlock, accent: string): string {
  if (block.kind === "paragraph") {
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${TEXT};">${escapeHtml(block.text)}</p>`;
  }
  if (block.kind === "note") {
    return `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:${MUTED};">${escapeHtml(block.text)}</p>`;
  }
  const url = safeUrl(block.url, ACTION_SCHEMES);
  const label = escapeHtml(block.label);
  if (!url) {
    // Degrade: never emit a live hostile action link.
    return `<p style="margin:0 0 16px;font-size:15px;font-weight:600;color:${TEXT};">${label}</p>`;
  }
  const href = escapeHtml(url);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">` +
    `<tr><td style="border-radius:6px;background:${accent};">` +
    `<a href="${href}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a>` +
    `</td></tr></table>` +
    `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:${MUTED};">Or paste this link into your browser:<br /><a href="${href}" style="color:${MUTED};">${href}</a></p>`
  );
}

function renderFooter(brand: BrandConfig): string {
  const name = escapeHtml(brand.appName);
  const appUrl = safeUrl(brand.appUrl, APP_URL_SCHEMES);
  const identity = appUrl
    ? `<a href="${escapeHtml(appUrl)}" style="color:${MUTED};">${name}</a>`
    : name;
  const links = safeFooterLinks(brand);
  const linksRow = links.length
    ? `<div style="margin-top:8px;">${links
        .map(
          (link) =>
            `<a href="${escapeHtml(link.url)}" style="color:${MUTED};text-decoration:underline;margin:0 8px;">${escapeHtml(link.label)}</a>`,
        )
        .join("")}</div>`
    : "";
  return (
    `<td style="padding:20px 32px;border-top:1px solid ${BORDER};font-size:12px;line-height:1.6;color:${MUTED};">` +
    `<div>${identity}</div>${linksRow}</td>`
  );
}

/**
 * Build the client-robust HTML part: a full document with a `color-scheme`
 * meta for dark-mode clients, a table-based centered container capped at 600px,
 * inline CSS on every element, and the branded-vs-neutral gating (logo, accent,
 * footer links) applied here so the five templates stay thin.
 */
export function renderShell(brand: BrandConfig, content: EmailContent): string {
  const accent = accentColor(brand);
  const preheader = content.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preheader)}</div>`
    : "";
  const body = content.blocks.map((b) => renderBlock(b, accent)).join("");
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" />` +
    `<meta name="color-scheme" content="light dark" />` +
    `<meta name="supported-color-schemes" content="light dark" />` +
    `<style>:root{color-scheme:light dark;}</style>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${PAGE_BG};">` +
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${CONTAINER_BG};border:1px solid ${BORDER};border-radius:10px;overflow:hidden;">` +
    `<tr>${renderHeader(brand)}</tr>` +
    `<tr><td style="padding:28px 32px;">` +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${TEXT};">${escapeHtml(content.heading)}</h1>` +
    body +
    `</td></tr>` +
    `<tr>${renderFooter(brand)}</tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/**
 * Build the plain-text part mirroring the HTML content. Each action URL sits on
 * its own line with no punctuation glued to it, keeping `LogSender`'s text-URL
 * extractor clean. Degrades an unsafe action to its label with no URL, matching
 * the HTML shell.
 */
export function renderText(brand: BrandConfig, content: EmailContent): string {
  const lines: string[] = [brand.appName, "", content.heading, ""];
  for (const block of content.blocks) {
    if (block.kind === "action") {
      const url = safeUrl(block.url, ACTION_SCHEMES);
      lines.push(`${block.label}:`);
      if (url) lines.push(url);
      lines.push("");
    } else {
      lines.push(block.text, "");
    }
  }
  lines.push("--", brand.appName);
  const appUrl = safeUrl(brand.appUrl, APP_URL_SCHEMES);
  if (appUrl) lines.push(appUrl);
  for (const link of safeFooterLinks(brand)) {
    lines.push(`${link.label}: ${link.url}`);
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
