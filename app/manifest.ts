import type { MetadataRoute } from "next";

/**
 * Web app manifest for the Piyaz PWA.
 * @returns Manifest with brand identity, theme colors, and home-screen icons.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Piyaz",
    short_name: "Piyaz",
    description:
      "A structure that supports organic growth. Track projects created by your coding agent.",
    start_url: "/",
    display: "standalone",
    background_color: "#07080a",
    theme_color: "#07080a",
    icons: [
      {
        src: "/piyaz-icon-dark-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/piyaz-icon-dark.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
