"use client";
import Link from "next/link";
import type { Route } from "next";
import { useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";
const key = "vh-home-map-collapsed";
function subscribe(change: () => void) { window.addEventListener("storage", change); window.addEventListener("vh-home-map", change); return () => { window.removeEventListener("storage", change); window.removeEventListener("vh-home-map", change); }; }
function collapsed() { try { return localStorage.getItem(key) === "1"; } catch { return false; } }
const steps: { title: string; description: string; links: { href: Route; label: string }[] }[] = [
  { title: "House & belongings", description: "Equipment and trees belong to places in your house.", links: [{ href: "/house", label: "House view" }, { href: "/equipment", label: "Equipment" }, { href: "/house?scope=trees", label: "Trees" }] },
  { title: "Plans → tasks", description: "Plans create tasks. Projects collect related work.", links: [{ href: "/plans", label: "Maintenance plans" }, { href: "/today#work-queue", label: "Tasks" }, { href: "/projects", label: "Projects" }] },
  { title: "Prepare & do", description: "Tasks use instructions, supplies and professional help.", links: [{ href: "/procedures", label: "Instructions" }, { href: "/supplies", label: "Supplies" }, { href: "/supplies/shopping", label: "Shopping" }, { href: "/providers", label: "Professionals" }] },
  { title: "Work → records", description: "Completions preserve history; documents support your records.", links: [{ href: "/history", label: "Completed work" }, { href: "/documents", label: "Documents" }] },
];
export function Relationships() {
  const isCollapsed = useSyncExternalStore(subscribe, collapsed, () => false);
  return <section aria-label="How your home records connect" className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">How your home connects</h2><button type="button" aria-expanded={!isCollapsed} aria-controls="home-relationships" className="min-h-11 px-2 text-sm text-accent-text" onClick={() => { try { localStorage.setItem(key, isCollapsed ? "0" : "1"); } catch {} window.dispatchEvent(new Event("vh-home-map")); }}>{isCollapsed ? "Show guide" : "Hide guide"}</button></div><div id="home-relationships" hidden={isCollapsed}><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{steps.map((step, index) => <div key={step.title} className="relative rounded-lg border border-line bg-surface p-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{step.title}</h3>{index < steps.length - 1 && <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-ink-3"/>}</div><p className="mt-1 text-xs text-ink-3">{step.description}</p><div className="mt-2 flex flex-col">{step.links.map(link => <Link key={link.href} href={link.href} className="py-1.5 text-sm text-accent-text underline-offset-2 hover:underline">{link.label}</Link>)}</div></div>)}</div><div className="mt-2 flex flex-wrap gap-x-5 text-xs text-ink-3"><Link href="/notifications" className="py-2">Notifications</Link><Link href="/search" className="py-2">Search everything</Link><Link href="/settings" className="py-2">Settings</Link></div></div></section>;
}
