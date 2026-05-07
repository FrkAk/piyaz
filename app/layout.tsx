import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { MotionProvider } from "@/components/layout/MotionProvider";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { RealtimeBridge } from "@/components/providers/RealtimeBridge";
import { SessionProvider } from "@/components/providers/SessionProvider";
import "./globals.css";

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "mymir",
  description: "A structure that supports organic growth. Track projects created by your coding agent.",
};

/**
 * Root layout for the Mymir application.
 * Reads theme from cookie for SSR, falls back to blocking script for first visit.
 * @param props - Layout props with children.
 * @returns The root HTML structure with fonts and theme applied.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const raw = cookieStore.get("mymir-theme")?.value;
  const theme = raw === "light" ? "light" : "dark";

  return (
    <html lang="en" suppressHydrationWarning className={theme === "light" ? "light" : ""}>
      <head>
        {/* Blocking script: handles first visit (no cookie yet) before React hydrates */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            try { if(localStorage.getItem('mymir-theme')==='light') document.documentElement.classList.add('light'); } catch(e){}
          })();
        ` }} />
      </head>
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
