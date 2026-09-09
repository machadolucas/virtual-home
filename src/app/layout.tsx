import type { Metadata, Viewport } from "next";
import { inter } from "./fonts";
import { ToastViewport } from "@/ui/Toast";
import { PwaRegistration } from "@/ui/shell/PwaRegistration";
import { themeScript } from "@/ui/shell/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "virtual-home",
    template: "%s · virtual-home",
  },
  description: "Home management for one household: schedules, supplies and the house itself.",
  applicationName: "virtual-home",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/house.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192-v2.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-v2.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "virtual-home",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false, address: false, date: false },
  // A private LAN app; never index it even if something proxies it outward.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The house workspace and the phone sheets both draw into the safe areas.
  viewportFit: "cover",
  // Matches --vh-paper-0 in globals.css for both modes.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#161513" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // `suppressHydrationWarning`: the blocking script below writes `data-theme` and `style` on this
    // element before React sees it, so the server's markup and the client's DOM legitimately differ
    // by exactly those two attributes. Nothing else on the element is generated.
    <html lang="en" className={`${inter.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/*
          The stored theme, applied before the first paint.
          It cannot be a component or an effect: a pinned dark theme applied after hydration is a
          white flash on every navigation. `script-src` already allows `'unsafe-inline'`
          (`next.config.ts`), and the whole body is inside a `try` — `localStorage` throws outright
          in some privacy modes, and a colour preference is not worth a blank page.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeScript() }} />
      </head>
      <body className="min-h-dvh bg-paper font-sans text-ink">
        {children}
        <ToastViewport />
        <PwaRegistration />
      </body>
    </html>
  );
}
