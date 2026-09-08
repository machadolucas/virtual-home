import type { Metadata, Viewport } from "next";
import { inter } from "./fonts";
import { ToastViewport } from "@/ui/Toast";
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
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
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
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-dvh bg-paper font-sans text-ink">
        {children}
        <ToastViewport />
      </body>
    </html>
  );
}
