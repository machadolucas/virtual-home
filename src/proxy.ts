import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gate only: checks that a session cookie EXISTS (not that it is valid) so we can
 * redirect navigations cheaply and mark HTML as non-cacheable. The real authorization boundary is
 * `requireSession()` in every handler/page (see CLAUDE.md rule 2).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isNavigation = request.headers.get("sec-fetch-mode") === "navigate";

  if (!getSessionCookie(request, { cookiePrefix: "vh" })) {
    if (isNavigation) {
      const url = new URL("/login", request.url);
      url.searchParams.set("next", pathname + search);
      return NextResponse.redirect(url);
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = NextResponse.next();
  if (isNavigation) res.headers.set("Cache-Control", "private, no-store, must-revalidate");
  return res;
}

export const config = {
  matcher: [
    // `_next` is excluded wholesale, not just `static`/`image`: the dev client also talks to
    // `_next/hmr` and `_next/devtools`, and answering those with a 401 breaks dev tooling.
    // Real navigations and RSC requests use the page's own URL, so they stay behind this gate.
    "/((?!api/auth|api/health|login|_next/|favicon.ico|icons/|manifest.webmanifest|sw.js|offline.html|fonts/).*)",
  ],
};
