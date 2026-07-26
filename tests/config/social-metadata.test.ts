import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { metadata } from "@/app/layout";
import { metadata as publicMetadata } from "@/app/(public)/layout";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { APP_URL } from "@/lib/config/urls";

/**
 * Pins the link-unfurl and indexing contract for the app host. Preview bots
 * (Slackbot, Twitterbot, Discordbot) honour robots.txt, so a blanket `disallow`
 * stops them fetching the page and reading `og:image` at all. Indexing is held
 * off by the `noindex` directive in root metadata, not by robots.txt, with the
 * legal route group as the single deliberate exception. These tests fail if
 * either half of that pairing regresses, if the exception spreads to another
 * route file, if a legal page loses its self-canonical or its sitemap entry, or
 * if `og.png` stops being a 1200x630 PNG.
 */

const OG_PATH = join(import.meta.dir, "../../public/og.png");

/** Route files that can declare their own metadata, relative to the repo root. */
const ROUTE_FILES = "app/**/{layout,page}.tsx";

/** Pages inside the route group that opts back into indexing. */
const LEGAL_PAGES = "app/(public)/*/page.tsx";

/**
 * Lists the legal document routes by reading the filesystem, so the assertions
 * track the pages that actually exist rather than a hardcoded copy of them.
 *
 * @returns Sorted route paths, e.g. `["/dpa", "/impressum", ...]`.
 * @throws If the glob matches nothing, which would make callers pass vacuously.
 */
function legalRoutes(): string[] {
  const paths = [...new Bun.Glob(LEGAL_PAGES).scanSync(".")];
  if (paths.length === 0) {
    throw new Error(
      `expected ${LEGAL_PAGES} to match the legal document pages`,
    );
  }
  return paths.map((path) => `/${path.split("/").at(-2)}`).sort();
}

type OgImageDescriptor = {
  url: string;
  width: number;
  height: number;
  alt?: string;
};

type PngSize = { width: number; height: number };

/**
 * Reads a PNG's intrinsic size from its IHDR chunk.
 *
 * @param path - Absolute path to a PNG file.
 * @returns Width and height in pixels.
 */
function readPngSize(path: string): PngSize {
  const header = readFileSync(path).subarray(0, 24);
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  };
}

/**
 * Reads the single Open Graph image descriptor declared by root metadata.
 *
 * @returns The declared descriptor.
 * @throws If metadata does not declare exactly one image.
 */
function ogImageDescriptor(): OgImageDescriptor {
  const images = metadata.openGraph?.images;
  if (!Array.isArray(images) || images.length !== 1) {
    throw new Error("expected root metadata to declare exactly one og image");
  }
  return images[0] as unknown as OgImageDescriptor;
}

/**
 * Reads the Twitter card fields declared by root metadata.
 *
 * @returns The card type and image list.
 */
function twitterCard(): { card?: string; images?: string[] } {
  return (metadata.twitter ?? {}) as { card?: string; images?: string[] };
}

describe("robots.txt", () => {
  test("allows fetching so preview bots can read og tags", () => {
    const rules = robots().rules;
    expect(Array.isArray(rules)).toBe(false);
    const single = rules as { userAgent?: string; allow?: string };
    expect(single.userAgent).toBe("*");
    expect(single.allow).toBe("/");
  });

  test("keeps /api/ disallowed so a bot cannot burn an emailed auth token", () => {
    const single = robots().rules as { disallow?: string | string[] };
    expect(single.disallow).toBe("/api/");
  });

  test("advertises the sitemap", () => {
    expect(robots().sitemap).toBe(`${APP_URL}/sitemap.xml`);
  });
});

describe("root metadata", () => {
  test("still opts out of indexing", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  test("openGraph declares the og image at 1200x630", () => {
    expect(ogImageDescriptor()).toMatchObject({ width: 1200, height: 630 });
  });

  test("twitter uses summary_large_image with an image", () => {
    expect(twitterCard().card).toBe("summary_large_image");
    expect(twitterCard().images).toHaveLength(1);
  });

  test("openGraph and twitter point at the same asset", () => {
    expect(twitterCard().images?.[0]).toBe(ogImageDescriptor().url);
  });

  test("declares no sitewide canonical, which would point every route at /", () => {
    expect(metadata.alternates).toBeUndefined();
  });

  test("declares no og:url, which would collapse distinct shared links", () => {
    expect(metadata.openGraph?.url).toBeUndefined();
  });
});

describe("indexing scope", () => {
  test("the legal route group opts back into indexing", () => {
    expect(publicMetadata.robots).toMatchObject({ index: true, follow: true });
  });

  test("no other route file overrides the sitewide noindex", () => {
    const overriding = [...new Bun.Glob(ROUTE_FILES).scanSync(".")]
      .filter((path) => /\brobots\s*:/.test(readFileSync(path, "utf8")))
      .sort();
    expect(overriding).toEqual(["app/(public)/layout.tsx", "app/layout.tsx"]);
  });

  test("each legal page self-canonicals to its own route", () => {
    for (const route of legalRoutes()) {
      const source = readFileSync(`app/(public)${route}/page.tsx`, "utf8");
      expect(source).toContain(`canonical: "${route}"`);
    }
  });

  test("the sitemap lists every indexable page and nothing else", () => {
    const listed = sitemap()
      .map((entry) => entry.url)
      .sort();
    expect(listed).toEqual(legalRoutes().map((route) => `${APP_URL}${route}`));
  });
});

describe("og.png asset", () => {
  test("is a 1200x630 PNG", () => {
    expect(readPngSize(OG_PATH)).toEqual({ width: 1200, height: 630 });
  });

  test("matches the dimensions declared in metadata", () => {
    const declared = ogImageDescriptor();
    expect(readPngSize(OG_PATH)).toEqual({
      width: declared.width,
      height: declared.height,
    });
  });
});
