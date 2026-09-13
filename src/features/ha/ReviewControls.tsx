"use client";
import type { Route } from "next";
import { useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Button, Switch, toast } from "@/ui";
import { setHaIgnored } from "@/server/actions/ha/review";
import type { ReviewTarget } from "@/server/services/haReview";
export function IgnoreButton({ targets, ignored = false, label, onDone }: { targets: ReviewTarget[]; ignored?: boolean; label?: string; onDone?: () => void }) {
  const router = useRouter(); const [pending, start] = useTransition();
  async function change(value: boolean) {
    const result = await setHaIgnored({ targets, ignored: value });
    if (!result.ok) { toast({ title: "Could not change import preference", description: result.error, tone: "error" }); return; }
    router.refresh(); onDone?.();
    toast({ title: value ? "Ignored in virtual-home" : "Restored to import choices", description: "Home Assistant and existing equipment links are unchanged.", action: { label: "Undo", onClick: () => { void change(!value); } } });
  }
  return <Button variant="ghost" size="sm" loading={pending} disabled={!targets.length} onClick={() => start(() => change(!ignored))}>{label ?? (ignored ? "Restore" : "Ignore")}</Button>;
}
export function IgnoredItems({ items, showIgnored }: { items: (ReviewTarget & { name: string })[]; showIgnored: boolean }) {
  const [selected, setSelected] = useState<string[]>([]); const router = useRouter(); const params = useSearchParams(); const pathname = usePathname();
  return <div className="space-y-3"><Switch label={`Show ignored items (${items.length})`} checked={showIgnored} onCheckedChange={show => { const next = new URLSearchParams(params); if (show) next.set("ignored", "1"); else next.delete("ignored"); router.replace(`${pathname}?${next}` as Route, { scroll: false }); }}/>{items.length > 0 && <details><summary className="cursor-pointer text-sm">Manage ignored items</summary><p className="my-2 text-sm text-ink-3">These local choices survive registry syncs. Restore items here even if they are hidden or unavailable in Home Assistant.</p><div className="max-h-72 overflow-y-auto">{items.map(item => { const key = `${item.kind}:${item.registryId}`; return <label key={key} className="flex items-center gap-2 border-b border-line py-2 text-sm"><input type="checkbox" checked={selected.includes(key)} onChange={e => setSelected(current => e.target.checked ? [...current, key] : current.filter(value => value !== key))}/><span className="min-w-0 flex-1 break-words">{item.name} <span className="text-ink-3">· {item.kind}</span></span></label>; })}</div><IgnoreButton ignored targets={items.filter(item => selected.includes(`${item.kind}:${item.registryId}`))} label={`Restore selected (${selected.length})`} onDone={() => setSelected([])}/></details>}</div>;
}
