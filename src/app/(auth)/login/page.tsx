import type { Route } from "next";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFreshSession, safeNextPath } from "@/server/auth/session";
import { HouseMark } from "@/ui/shell";
import { listLoginHints } from "./hints";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function LoginPage(props: PageProps<"/login">) {
  const searchParams = await props.searchParams;
  const raw = searchParams["next"];
  // Only same-origin relative paths survive: a crafted Home Assistant
  // notification link must not be able to bounce us off-site after sign-in.
  const next = safeNextPath(typeof raw === "string" ? raw : null);

  // Already signed in: go straight where they were heading.
  // Fresh check: a revoked session must not bounce the user between /login and the app for 60 s.
  if (await getFreshSession()) redirect((next) as Route);

  const hints = await listLoginHints();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="grid size-12 place-items-center rounded-lg border border-line bg-surface text-accent shadow-panel">
          <HouseMark className="size-7" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">virtual&#8209;home</h1>
          <p className="mt-1 text-sm leading-6 text-ink-2">
            Sign in to see what the house needs.
          </p>
        </div>
      </header>

      <div className="rounded-xl border border-line bg-surface p-5 shadow-pop sm:p-6">
        <LoginForm hints={hints} next={next} />
      </div>

      <p className="text-center text-xs leading-5 text-ink-3">
        Forgotten your password? Recovery runs on the machine itself —{" "}
        <code className="font-mono">pnpm vh-admin set-password</code> over SSH. There is no email
        here to send a reset link to, and therefore none to intercept.
      </p>
    </div>
  );
}
