import type { MetadataRoute } from "next";

// Canonical production origin. Hardcoded because robots.txt is statically
// prerendered at build time, where the BETTER_AUTH_URL runtime var is absent.
const baseUrl = "https://app.piyaz.ai";

/**
 * robots.txt for the Piyaz app. The app is auth-gated, so allow the public
 * entry point and keep crawlers out of authenticated areas and the API.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/my-tasks",
        "/settings",
        "/project/",
        "/onboarding/",
        "/dev/",
        "/api/",
      ],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
