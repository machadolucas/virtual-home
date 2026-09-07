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
    "/((?!api/auth|api/health|login|_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|fonts/).*)",
  ],
};
