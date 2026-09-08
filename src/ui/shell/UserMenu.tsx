"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronDown, LogOut, Settings, ShieldCheck } from "lucide-react";
import { authClient } from "@/server/auth/client";
import { cn, focusRing, focusRingInset } from "../cn";
import { Avatar } from "../Avatar";
import { Popover, PopoverClose } from "../Popover";
import { Spinner } from "../Spinner";
import { toasts } from "../Toast";
import { SETTINGS_NAV } from "./nav";
import { ThemeMenu } from "./ThemeMenu";

export interface UserMenuProps {
  name: string;
  username: string | null;
  displayColor: string | null;
}

const rowClass = cn(
  "flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-sm font-medium",
  "text-ink-2 transition-colors duration-100 hover:bg-surface-3 hover:text-ink md:min-h-9",
  "[&_svg]:size-4 [&_svg]:shrink-0",
  focusRingInset,
);

/**
 * Identity and the two things a signed-in person needs from anywhere: their
 * security page and the way out. Settings also lives here, because on phones
 * there is no sidebar to hold it.
 */
export function UserMenu({ name, username, displayColor }: UserMenuProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
      router.push("/login");
    } catch {
      setSigningOut(false);
      toasts.error("Could not sign out", "The session may still be active. Try again.");
    }
  }

  return (
    <Popover
      ariaLabel={`Account: ${name}`}
      align="end"
      padded={false}
      className="w-64 p-1.5"
      trigger={
        <button
          type="button"
          aria-label={`Account: ${name}`}
          className={cn(
            "flex min-h-11 shrink-0 items-center gap-1.5 rounded-full pl-0.5 pr-1.5 md:min-h-9",
            "transition-colors duration-100 hover:bg-surface-3",
            focusRing,
          )}
        >
          <Avatar name={name} color={displayColor} size="sm" />
          <span className="hidden max-w-28 truncate text-sm font-medium text-ink sm:block">
            {name}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 text-ink-3" />
        </button>
      }
    >
      <div className="flex items-center gap-2.5 px-2 pb-2 pt-1">
        <Avatar name={name} color={displayColor} size="md" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-ink">{name}</span>
          {username ? (
            <span className="truncate font-mono text-xs text-ink-3">{username}</span>
          ) : null}
        </span>
      </div>

      <div className="my-1 h-px bg-line" />

      <ThemeMenu />

      <div className="my-1 h-px bg-line" />

      <ul className="flex list-none flex-col gap-0.5">
        <li>
          <PopoverClose asChild>
            <Link href="/settings/security" className={rowClass}>
              <ShieldCheck aria-hidden="true" />
              Security
            </Link>
          </PopoverClose>
        </li>
        <li className="md:hidden">
          <PopoverClose asChild>
            <Link href="/settings" className={rowClass}>
              <Settings aria-hidden="true" />
              Settings
            </Link>
          </PopoverClose>
        </li>
      </ul>

      <div className="my-1 h-px bg-line" />

      <button type="button" onClick={signOut} disabled={signingOut} className={rowClass}>
        {signingOut ? <Spinner /> : <LogOut aria-hidden="true" />}
        {signingOut ? "Signing out…" : "Sign out"}
      </button>

      <p className="px-2 pb-1 pt-2 text-[0.6875rem] leading-4 text-ink-3">
        {SETTINGS_NAV.length} settings pages. Password recovery is CLI&#8209;only.
      </p>
    </Popover>
  );
}
