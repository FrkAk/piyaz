import type { MetadataRoute } from "next";

const baseUrl = "https://app.piyaz.ai";

/**
 * robots.txt for the Piyaz app. Fetching is allowed so link preview bots can
 * read the Open Graph tags on shared app links. Indexing stays off via the
 * `noindex` directive in root metadata, which a crawler can only honour once
 * it is permitted to fetch the page at all. Public indexing lives on the apex
 * marketing site (piyaz.ai) instead.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    host: baseUrl,
  };
}
