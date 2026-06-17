import type { MetadataRoute } from "next";

const baseUrl = "https://app.piyaz.ai";

/**
 * robots.txt for the Piyaz app. The app host is invite-only and fully
 * auth-gated, so it carries no public SEO — all crawling is disallowed.
 * Public indexing lives on the apex marketing site (piyaz.ai) instead.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
    host: baseUrl,
  };
}
