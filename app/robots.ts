import type { MetadataRoute } from "next";

const baseUrl = "https://app.piyaz.ai";

/**
 * robots.txt for the Piyaz app. Page fetching is allowed so link preview bots
 * can read the Open Graph tags on shared app links. Indexing stays off via the
 * `noindex` directive in root metadata, which a crawler can only honour once it
 * is permitted to fetch the page at all. Public indexing lives on the apex
 * marketing site (piyaz.ai) instead.
 *
 * `/api/` stays disallowed: Open Graph tags live on pages, never on API routes,
 * and Better Auth's emailed links (`/api/auth/verify-email`,
 * `/api/auth/reset-password/<token>`) consume their token on GET. A bot
 * unfurling a pasted verification link would otherwise burn it before the
 * recipient clicks.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    host: baseUrl,
  };
}
