import type { MetadataRoute } from "next";

// Canonical production origin. Hardcoded because sitemap.xml is statically
// prerendered at build time, where the BETTER_AUTH_URL runtime var is absent.
const baseUrl = "https://app.piyaz.ai";

/**
 * Sitemap for the Piyaz app. Only the public entry point is indexable; every
 * other route sits behind authentication and is excluded via robots.ts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${baseUrl}/`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
