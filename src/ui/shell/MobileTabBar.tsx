"use client";
import type { Route } from "next";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, Settings } from "lucide-react";
import { Sheet } from "../Sheet";
import { cn, focusRingInset } from "../cn";
import { MAIN_NAV, NAV_GROUPS, sectionActive } from "./nav";

const PRIMARY = ["/today", "/house", "/equipment", "/supplies/shopping"];
export function MobileTabBar({ className }: { className?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const primary = PRIMARY.map((href) => MAIN_NAV.find((item) => item.href === href)!);
  const moreActive = !primary.some((item) => sectionActive(item, pathname));
  const style = (active: boolean) => cn("flex h-tabbar min-w-0 flex-col items-center justify-center gap-1 px-1 text-[0.6875rem] font-medium", active ? "bg-accent-soft text-accent-text" : "text-ink-3", focusRingInset);
  return <>
    <nav aria-label="Sections" className={cn("shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]", className)}>
      <ul className="grid list-none grid-cols-5">
        {primary.map((item) => <li key={item.href}><Link href={(item.href) as Route} aria-label={item.label} aria-current={sectionActive(item, pathname) ? "page" : undefined} className={style(sectionActive(item, pathname))}><item.icon aria-hidden="true" className="size-5" /><span className="truncate">{item.short ?? item.label}</span></Link></li>)}
        <li><button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-label="More sections" className={cn(style(moreActive), "w-full")}><Menu className="size-5" /><span>More</span></button></li>
      </ul>
    </nav>
    <Sheet open={open} onOpenChange={setOpen} title="All sections" description="Work, your house and household records.">
      {NAV_GROUPS.map((group) => <section key={group.label} className="mb-4"><h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">{group.label}</h2><ul className="grid grid-cols-2 gap-1">{group.hrefs.map((href) => MAIN_NAV.find((item) => item.href === href)!).map((item) => <li key={item.href}><Link href={(item.href) as Route} onClick={() => setOpen(false)} aria-current={sectionActive(item, pathname) ? "page" : undefined} className={cn("flex min-h-11 items-center gap-2 rounded-md px-2", sectionActive(item, pathname) ? "bg-accent-soft text-accent-text" : "hover:bg-surface-3")}><item.icon className="size-4" />{item.label}</Link></li>)}</ul></section>)}
      <Link href="/settings" onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-2 border-t border-line"><Settings className="size-4" />Settings</Link>
    </Sheet>
  </>;
}
