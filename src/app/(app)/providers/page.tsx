import Link from "next/link";
import { getDb } from "@/db/client";
import { requireSessionPage } from "@/server/auth/session";
import { listProviders } from "@/server/services/providers";
import { Badge, Button, EmptyState, Input, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
export const metadata = { title: "Providers" };
export default async function ProvidersPage({ searchParams }: { searchParams: Promise<{ q?: string; archived?: string }> }) {
  await requireSessionPage("/providers");
  const { q = "", archived } = await searchParams;
  const providers = listProviders(getDb().db, archived === "1").filter((row) => [row.name, row.trade, row.contactName, row.phone, row.email].some((v) => v?.toLocaleLowerCase().includes(q.toLocaleLowerCase())));
  return <PageScroll><PageHeader title="Providers" description="People and companies who help care for the house." actions={<Link href="/providers/new" className={buttonClasses({ size: "sm" })}>Add provider</Link>} />
    <form className="flex flex-wrap items-center gap-2 mb-4"><Input name="q" aria-label="Find a provider" placeholder="Name, trade or contact…" defaultValue={q} /><Button type="submit" size="sm" variant="secondary">Search</Button><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="archived" value="1" defaultChecked={archived === "1"} />Include archived</label></form>
    {providers.length ? <Panel><ul className="divide-y divide-line">{providers.map((row) => <li key={row.id} className="py-3 flex gap-3 items-center"><div className="min-w-0 flex-1"><Link href={`/providers/${row.id}`} className="font-medium text-accent-text hover:underline">{row.name}</Link><p className="text-sm text-ink-2">{[row.trade, row.contactName, row.phone].filter(Boolean).join(" · ")}</p></div>{row.isPreferred && <Badge>Preferred</Badge>}{row.archivedAtMs !== null && <Badge>Archived</Badge>}</li>)}</ul></Panel> : <EmptyState title={q ? "No matching providers" : "No providers yet"} description="Add a tradesperson or company, then choose them when planning or booking maintenance." actions={<Link href="/providers/new" className={buttonClasses({ variant: "secondary" })}>Add provider</Link>} />}
  </PageScroll>;
}
