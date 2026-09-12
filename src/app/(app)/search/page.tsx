import type { Route } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { requireSessionPage } from "@/server/auth/session";
import { searchRecords } from "@/server/queries/search";
import { Button, EmptyState, Input, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
export const metadata = { title: "Search" };
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; page?: string }> }) {
  await requireSessionPage("/search");
  const { q = "", kind, page: rawPage } = await searchParams;
  const page = Math.max(1, Math.min(1000, Number.parseInt(rawPage ?? "1", 10) || 1));
  const groups = searchRecords(getDb().db, q, { limit: 25, kind, offset: kind ? (page - 1) * 25 : 0 });
  const href = (group: string, targetPage: number) => `/search?${new URLSearchParams({ q, kind: group, page: String(targetPage) })}`;
  return <PageScroll><PageHeader title="Search" description="Find equipment, rooms, supplies, plans, procedures, projects, people and recorded work." /><form className="mb-4 flex gap-2"><Input name="q" aria-label="Search the house" type="search" defaultValue={q} minLength={2} maxLength={200} required /><Button type="submit">Search</Button></form>{kind && <Link href={`/search?${new URLSearchParams({ q })}`} className="mb-4 inline-block text-sm text-accent-text underline">All result types</Link>}
    {!groups.length && <EmptyState title={q.trim().length < 2 ? "What are you looking for?" : "No matches"} description={q.trim().length < 2 ? "Enter at least two characters." : "Try a name, model number, trade or different wording."} />}
    {groups.map((group) => <Panel key={group.kind} title={group.label} footer={<div className="flex justify-between gap-3">{kind && page > 1 && <Link href={(href(group.kind, page - 1)) as Route} className={buttonClasses({ size: "sm", variant: "ghost" })}>Previous</Link>}{group.hasMore && <Link href={(href(group.kind, kind ? page + 1 : 2)) as Route} className={buttonClasses({ size: "sm", variant: "ghost" })}>More {group.label.toLowerCase()}</Link>}</div>}><ul className="divide-y divide-line">{group.hits.map((hit) => <li key={hit.id}><Link href={(hit.href) as Route} className="block py-3 hover:text-accent-text"><span className="font-medium">{hit.label}</span>{hit.secondary && <p className="text-sm text-ink-2">{hit.secondary}</p>}</Link></li>)}</ul></Panel>)}
  </PageScroll>;
}
