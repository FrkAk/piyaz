import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { MotionProvider } from "@/components/layout/MotionProvider";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { RealtimeBridge } from "@/components/providers/RealtimeBridge";
import { SessionProvider } from "@/components/providers/SessionProvider";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const siteUrl = "https://app.piyaz.ai";
const description =
  "A structure that supports organic growth. Track projects created by your coding agent.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Piyaz",
    template: "%s · Piyaz",
  },
  description,
  robots: {
    index: false,
    follow: false,
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: "Piyaz",
    url: "/",
    title: "Piyaz",
    description,
  },
  twitter: {
    card: "summary",
    title: "Piyaz",
    description,
  },
};

/**
 * Root layout for the Piyaz application.
 * Reads theme from cookie for SSR so the correct mode paints on first frame.
 * @param props - Layout props with children.
 * @returns The root HTML structure with fonts and theme applied.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const raw = cookieStore.get("piyaz-theme")?.value;
  const theme = raw === "light" ? "light" : "dark";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={theme === "light" ? "light" : ""}
    >
      <body>
        <ThemeProvider initialTheme={theme}>
          <QueryProvider>
            <SessionProvider>
              <RealtimeBridge />
              <MotionProvider>{children}</MotionProvider>
            </SessionProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
