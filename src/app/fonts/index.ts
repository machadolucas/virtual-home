/**
 * Typography for the whole app.
 *
 * Inter is vendored (not fetched from a CDN) because the app runs on a private
 * LAN with a strict CSP (`font-src 'self' data:`) and must work offline.
 * `InterVariable*.woff2` are the upstream variable builds from rsms.me/inter,
 * licensed under the SIL Open Font License 1.1 — see `Inter-LICENSE.txt` in
 * this directory. The files are unmodified.
 *
 * Monospace is a system fallback stack (see `--font-mono` in globals.css); no
 * mono webfont is shipped, since mono is only used for IDs, keys and `Kbd`.
 */
import localFont from "next/font/local";

export const inter = localFont({
  src: [
    {
      path: "./InterVariable.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "./InterVariable-Italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-inter",
  display: "swap",
  preload: true,
  fallback: [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ],
  adjustFontFallback: "Arial",
});
