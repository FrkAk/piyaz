/**
 * URL classifier for task_links.
 *
 * Pure string parser. No DB, no network, no env access. Same function feeds both
 * the UI add path (`addTaskLink`) and the MCP `prUrl` sugar path so labels and
 * kinds stay consistent across surfaces.
 */

export type LinkKind = "pull_request" | "issue" | "commit" | "doc" | "link";

export interface ClassifiedLink {
  kind: LinkKind;
  label: string;
  host: string;
  /**
   * Canonical URL after scheme normalization. Always carries an `http:` or
   * `https:` scheme and a trailing-slash-normalized path. Callers should
   * persist this rather than the raw input so the `unique(taskId, url)`
   * constraint dedups variants like `github.com/x` vs `https://github.com/x`.
   */
  url: string;
  owner?: string;
  repo?: string;
  number?: number;
}

/**
 * Raised when `new URL(rawUrl)` cannot parse the input. Boundary handlers
 * (UI form, MCP tool handler) catch this and surface a clean validation message
 * rather than letting it propagate to the DB layer.
 */
export class MalformedLinkError extends Error {
  /**
   * @param url - The raw input that failed parsing.
   * @param cause - Underlying error from `new URL(...)`.
   */
  constructor(
    public readonly url: string,
    cause?: unknown,
  ) {
    super(`Malformed URL: ${url}`);
    this.name = "MalformedLinkError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Internal classifier-helper return shape. Sub-classifiers don't know the
 * canonical URL — {@link classifyLink} layers it on after parse + protocol-gate.
 */
type ClassifiedLinkSeed = Omit<ClassifiedLink, "url">;

const HOST_NORMALIZE_RE = /^www\./;

function normalizeHost(host: string): string {
  return host.replace(HOST_NORMALIZE_RE, "").toLowerCase();
}

function truncateLabel(value: string, max = 60): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

function shortenSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * Parse a GitHub URL path into a classified link.
 *
 * Matches `<owner>/<repo>/(pull|issues|commit)/<n>` and produces an owner+repo label.
 *
 * @param host - The URL's hostname (already normalized).
 * @param segments - Path segments split on `/`, with empty segments removed.
 * @returns Classified link or null if the path doesn't match.
 */
function classifyGithub(host: string, segments: string[]): ClassifiedLinkSeed | null {
  if (segments.length < 4) return null;
  const [owner, repo, kindSeg, idSeg] = segments;
  if (kindSeg === "pull") {
    const number = Number.parseInt(idSeg, 10);
    if (!Number.isFinite(number)) return null;
    return {
      kind: "pull_request",
      label: `${owner}/${repo}#${number}`,
      host,
      owner,
      repo,
      number,
    };
  }
  if (kindSeg === "issues") {
    const number = Number.parseInt(idSeg, 10);
    if (!Number.isFinite(number)) return null;
    return {
      kind: "issue",
      label: `${owner}/${repo}#${number}`,
      host,
      owner,
      repo,
      number,
    };
  }
  if (kindSeg === "commit") {
    return {
      kind: "commit",
      label: `${owner}/${repo}@${shortenSha(idSeg)}`,
      host,
      owner,
      repo,
    };
  }
  return null;
}

/**
 * Parse a GitLab URL path. GitLab namespaces the kind under a `-` segment:
 * `<owner>/<repo>/-/(merge_requests|issues|commit)/<n>`.
 *
 * @param host - The URL's hostname.
 * @param segments - Path segments.
 * @returns Classified link or null.
 */
function classifyGitlab(host: string, segments: string[]): ClassifiedLinkSeed | null {
  const dashIdx = segments.indexOf("-");
  if (dashIdx < 2 || dashIdx + 2 >= segments.length) return null;
  const owner = segments.slice(0, dashIdx - 1).join("/");
  const repo = segments[dashIdx - 1];
  const kindSeg = segments[dashIdx + 1];
  const idSeg = segments[dashIdx + 2];
  if (kindSeg === "merge_requests") {
    const number = Number.parseInt(idSeg, 10);
    if (!Number.isFinite(number)) return null;
    return {
      kind: "pull_request",
      label: `${owner}/${repo}!${number}`,
      host,
      owner,
      repo,
      number,
    };
  }
  if (kindSeg === "issues") {
    const number = Number.parseInt(idSeg, 10);
    if (!Number.isFinite(number)) return null;
    return {
      kind: "issue",
      label: `${owner}/${repo}#${number}`,
      host,
      owner,
      repo,
      number,
    };
  }
  if (kindSeg === "commit") {
    return {
      kind: "commit",
      label: `${owner}/${repo}@${shortenSha(idSeg)}`,
      host,
      owner,
      repo,
    };
  }
  return null;
}

/**
 * Parse a Linear issue URL: `linear.app/<workspace>/issue/<ID>/<slug>`.
 *
 * @param host - The URL's hostname.
 * @param segments - Path segments.
 * @returns Classified link or null.
 */
function classifyLinear(host: string, segments: string[]): ClassifiedLinkSeed | null {
  const issueIdx = segments.indexOf("issue");
  if (issueIdx === -1 || issueIdx + 1 >= segments.length) return null;
  const id = segments[issueIdx + 1];
  return {
    kind: "issue",
    label: id,
    host,
  };
}

/**
 * Documentation hosts: Notion, Google Docs, Figma. The page title is not
 * available client-side, so the label is `<host> doc` as a uniform fallback.
 *
 * @param host - The URL's hostname.
 * @returns Classified link.
 */
function classifyDoc(host: string): ClassifiedLinkSeed {
  return {
    kind: "doc",
    label: `${host} doc`,
    host,
  };
}

/**
 * Parse a URL into a structured link descriptor.
 *
 * Recognised kinds:
 * - `pull_request`: GitHub `pull/<n>`, GitLab `merge_requests/<n>`.
 * - `issue`: GitHub / GitLab `issues/<n>`, Linear `issue/<id>`.
 * - `commit`: GitHub / GitLab `commit/<sha>`.
 * - `doc`: notion.so, docs.google.com, figma.com.
 * - `link`: everything else (fallback).
 *
 * Scheme-less input is normalized to `https://`. Users typing or pasting
 * `github.com/owner/repo/pull/1` get the same treatment as the fully-qualified
 * URL. The normalization runs only when the raw input fails to parse as-is,
 * so a user-supplied scheme (including `javascript:`) is preserved and then
 * rejected by the protocol gate below.
 *
 * @param rawUrl - User-supplied URL string.
 * @returns ClassifiedLink with kind, label, host, and optional owner/repo/number.
 * @throws {MalformedLinkError} When the URL constructor rejects the input or
 *   the parsed protocol is anything other than `http:` / `https:`. `javascript:`,
 *   `data:`, `file:`, and friends are stored verbatim and rendered as `href`,
 *   so accepting them would turn the Links section into a click-to-exec XSS
 *   vector. The protocol gate is the single chokepoint that both the UI
 *   (`addTaskLink`) and the MCP `prUrl` sugar funnel through.
 */
export function classifyLink(rawUrl: string): ClassifiedLink {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : `https://${trimmed}`;
    try {
      parsed = new URL(candidate);
    } catch (e) {
      throw new MalformedLinkError(rawUrl, e);
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MalformedLinkError(rawUrl);
  }

  const host = normalizeHost(parsed.host);
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  const url = parsed.toString();

  let seed: ClassifiedLinkSeed | null = null;
  if (host === "github.com") seed = classifyGithub(host, segments);
  else if (host === "gitlab.com") seed = classifyGitlab(host, segments);
  else if (host === "linear.app") seed = classifyLinear(host, segments);
  else if (host === "notion.so" || host.endsWith(".notion.site")) seed = classifyDoc(host);
  else if (host === "docs.google.com") seed = classifyDoc(host);
  else if (host === "figma.com") seed = classifyDoc(host);

  if (seed) return { ...seed, url };

  const label = truncateLabel(host + parsed.pathname.replace(/\/$/, ""));
  return { kind: "link", label, host, url };
}
