import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { metadata } from "@/app/layout";
import robots from "@/app/robots";

/**
 * Pins the link-unfurl contract for the app host. Preview bots (Slackbot,
 * Twitterbot, Discordbot) honour robots.txt, so a blanket `disallow` stops
 * them fetching the page and reading `og:image` at all. Indexing is held off
 * by the `noindex` directive in root metadata, not by robots.txt. These tests
 * fail if either half of that pairing regresses, or if `og.png` stops being a
 * 1200x630 PNG.
 */

const OG_PATH = join(import.meta.dir, "../../public/og.png");

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
    const single = rules as {
      userAgent?: string;
      allow?: string;
      disallow?: string;
    };
    expect(single.userAgent).toBe("*");
    expect(single.allow).toBe("/");
    expect(single.disallow).toBeUndefined();
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
