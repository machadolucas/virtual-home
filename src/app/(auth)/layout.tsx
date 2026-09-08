import type { ReactNode } from "react";

/**
 * The unauthenticated shell: no sidebar, no top bar, nothing to click except
 * the thing you came here to do.
 *
 * The drafting grid behind the card is a static CSS gradient masked to a soft
 * ellipse — a nod to a floor plan on a drawing board, with no image to load
 * and nothing that moves.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-paper px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "linear-gradient(var(--vh-line) 1px, transparent 1px), linear-gradient(90deg, var(--vh-line) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
          backgroundPosition: "center",
          maskImage: "radial-gradient(ellipse 70% 55% at 50% 45%, black, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 55% at 50% 45%, black, transparent 75%)",
        }}
      />
      <main className="relative w-full max-w-sm">{children}</main>
    </div>
  );
}
