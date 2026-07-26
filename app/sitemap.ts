import type { MetadataRoute } from "next";
import { APP_URL } from "@/lib/config/urls";

/** Legal documents, in reading order. The only indexable routes on this host. */
const LEGAL_ROUTES = [
  "/terms",
  "/privacy",
  "/impressum",
  "/dpa",
  "/subprocessors",
];

/**
 * Sitemap for the Piyaz app. Lists the legal documents, the single route group
 * that opts out of the sitewide `noindex`. The auth pages linking these
 * documents are `nofollow`, so no in-app crawl path reaches them and this is
 * their only discovery route besides inbound links from the marketing site.
 *
 * @returns One entry per legal document.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return LEGAL_ROUTES.map((path) => ({ url: `${APP_URL}${path}` }));
}
