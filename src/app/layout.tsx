import { headers } from "next/headers";
import { appOrigin } from "@/lib/origin";
import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { SessionProvider } from "next-auth/react";

import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

// Inter is the brand typeface (see the brand sheet).
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono-stack",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  // Was `NEXT_PUBLIC_SITE_URL`, which is not configured on any environment, so
  // every absolute metadata URL resolved to localhost in production.
  metadataBase: new URL(appOrigin()),
  title: {
    default: "Tiny CRM — Your whole business. Organized.",
    template: "%s · Tiny CRM",
  },
  description:
    "A simple AI-powered CRM for contacts, deals, projects, tasks, and everything that happens between them.",
  openGraph: {
    title: "Tiny CRM — Your whole business. Organized.",
    description:
      "A simple AI-powered CRM for contacts, deals, projects, tasks, and everything that happens between them.",
    type: "website",
  },
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#101110" },
  ],
};

/**
 * Applies the stored theme before first paint. Without this the app flashes
 * light before hydration for anyone who chose dark.
 */
const themeScript = `
(function(){
  try {
    var stored = localStorage.getItem('tc-theme') || 'system';
    var dark = stored === 'dark' || (stored === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The nonce src/proxy.ts generated for this response. Without it the theme
  // script is refused by our own Content-Security-Policy and every visitor who
  // chose dark mode gets a flash of light on each navigation.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} h-full`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <SessionProvider>
          <TooltipProvider delayDuration={250} skipDelayDuration={300}>
            {children}
          </TooltipProvider>
        </SessionProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast:
                "!rounded-xl !border !border-hairline !bg-panel !text-body !shadow-pop !font-sans",
              description: "!text-muted",
              actionButton: "!bg-brand-500 !text-white !rounded-full",
            },
          }}
        />
      </body>
    </html>
  );
}
