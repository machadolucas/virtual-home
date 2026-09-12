"use client";
import { useEffect, useState } from "react";
import type { ProjectLinkEntityKind } from "@/db/schema/infrastructure";
import { Button, Input, Select } from "@/ui";
export function RecordPicker({ kind, value, onChange, id }: { kind: ProjectLinkEntityKind | "project"; value: string; onChange: (value: string) => void; id?: string }) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ key: string; candidates: { id: string; label: string }[]; hasMore: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const key = `${kind}:${query}:${offset}`, ready = result?.key === key;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { void fetch(`/api/project-link-candidates?${new URLSearchParams({ kind, q: query, offset: String(offset) })}`, { signal: controller.signal }).then(async (r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ candidates: { id: string; label: string }[]; hasMore: boolean }>; }).then((r) => { setResult({ ...r, key }); setFailed(null); }).catch(() => { if (!controller.signal.aborted) setFailed(key); }); }, 150);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [kind, query, offset, key]);
  return <div className="flex flex-col gap-2"><Input id={id} type="search" aria-label="Search records" placeholder="Search by name…" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); onChange(""); }} maxLength={200} />
    {failed === key ? <p role="alert" className="text-sm text-overdue">Records could not be loaded. Change the search to retry.</p> : !ready ? <p role="status" className="text-xs text-ink-3">Loading records…</p> : <><Select ariaLabel="Matching record" value={value} onValueChange={onChange} options={result.candidates.map((r) => ({ value: r.id, label: r.label }))} placeholder={result.candidates.length ? "Choose a record…" : "No matching records"} /><div className="flex gap-2">{offset > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => { setOffset(Math.max(0, offset - 25)); onChange(""); }}>Previous</Button>}{result.hasMore && <Button type="button" variant="ghost" size="sm" onClick={() => { setOffset(offset + 25); onChange(""); }}>More results</Button>}</div></>}
  </div>;
}
