import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { completion, maintenanceOccurrence, maintenancePlan, serviceBooking, serviceDocument, serviceProvider } from "@/db/schema";
import { requireSessionPage } from "@/server/auth/session";
import { ProviderForm } from "@/features/providers/ProviderForm";
import { ArchiveProvider } from "@/features/providers/ArchiveProvider";
import { Badge, Panel } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
export const metadata = { title: "Provider" };
export default async function ProviderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { id } = await params;
  await requireSessionPage(`/providers/${id}`);
  const db = getDb().db, provider = db.select().from(serviceProvider).where(eq(serviceProvider.id, id)).get();
  if (!provider) notFound();
  const plans = db.select().from(maintenancePlan).where(eq(maintenancePlan.defaultProviderId, id)).all();
  const bookings = db.select({ id: serviceBooking.id, occurrenceId: serviceBooking.occurrenceId, status: serviceBooking.status, date: serviceBooking.scheduledLocalDate, title: maintenanceOccurrence.title }).from(serviceBooking).leftJoin(maintenanceOccurrence, eq(maintenanceOccurrence.id, serviceBooking.occurrenceId)).where(eq(serviceBooking.providerId, id)).orderBy(desc(serviceBooking.createdAtMs)).all();
  const work = db.select({ id: completion.id, occurrenceId: completion.occurrenceId, date: completion.completedLocalDate, voided: completion.voidedAtMs, title: maintenanceOccurrence.title }).from(completion).innerJoin(maintenanceOccurrence, eq(maintenanceOccurrence.id, completion.occurrenceId)).where(eq(completion.performedByProviderId, id)).orderBy(desc(completion.completedAtMs)).all();
  const documents = db.select().from(serviceDocument).where(eq(serviceDocument.providerId, id)).all();
  const edit = (await searchParams).edit === "1";
  return <PageScroll><PageHeader eyebrow={<Link href="/providers">Providers</Link>} title={provider.name} description={provider.trade ?? undefined} actions={<><Link href={`/providers/${id}${edit ? "" : "?edit=1"}`} className="text-sm text-accent-text underline">{edit ? "Back to details" : "Edit details"}</Link><ArchiveProvider providerId={id} archived={provider.archivedAtMs !== null} /></>} />
    {edit ? <Panel title="Contact details"><ProviderForm providerId={id} initial={provider} /></Panel> : <Panel title="Contact">{provider.archivedAtMs !== null && <Badge>Archived</Badge>}{provider.isPreferred && <Badge>Preferred</Badge>}<dl className="grid gap-3 sm:grid-cols-2 mt-3">{[["Contact person", provider.contactName], ["Phone", provider.phone], ["Email", provider.email], ["Website", provider.website], ["Address", provider.address], ["Business / VAT number", provider.vatId]].map(([label, value]) => value && <div key={label}><dt className="text-xs text-ink-3">{label}</dt><dd className="text-sm break-words">{label === "Phone" ? <a href={`tel:${value}`}>{value}</a> : label === "Email" ? <a href={`mailto:${value}`}>{value}</a> : label === "Website" && /^https?:\/\//i.test(value) ? <a href={value} target="_blank" rel="noopener noreferrer">{value}</a> : value}</dd></div>)}</dl>{provider.notes && <p className="mt-4 whitespace-pre-wrap text-sm">{provider.notes}</p>}</Panel>}
    <Panel title="Maintenance plans">{plans.length ? <ul className="space-y-2">{plans.map((p) => <li key={p.id}><Link className="text-accent-text hover:underline" href={`/plans/${p.id}`}>{p.title}</Link></li>)}</ul> : <p className="text-sm text-ink-2">No plans use this provider by default.</p>}</Panel>
    <Panel title="Bookings"><ul className="divide-y divide-line">{bookings.map((b) => <li key={b.id} id={`booking-${b.id}`} className="py-2 text-sm">{b.occurrenceId ? <Link className="text-accent-text hover:underline" href={`/tasks/${b.occurrenceId}`}>{b.title ?? "Booking"}</Link> : "Booking"}<span className="text-ink-2"> · {b.date ?? "Date not agreed"} · {b.status.replaceAll("_", " ")}</span></li>)}</ul>{!bookings.length && <p className="text-sm text-ink-2">No bookings recorded.</p>}</Panel>
    <Panel title="Completed work"><ul className="divide-y divide-line">{work.map((w) => <li key={w.id} className="py-2 text-sm"><Link className="text-accent-text hover:underline" href={`/history?completion=${encodeURIComponent(w.id)}`}>{w.title}</Link> · {w.date}{w.voided !== null && " · Voided"}</li>)}</ul>{!work.length && <p className="text-sm text-ink-2">No completed work recorded.</p>}</Panel>
    <Panel title="Service documents"><ul className="space-y-2">{documents.map((d) => <li key={d.id}><Link className="text-accent-text hover:underline" href={`/documents/${d.id}`}>{d.documentNo ?? d.kind}</Link></li>)}</ul>{!documents.length && <p className="text-sm text-ink-2">No service documents linked.</p>}</Panel>
  </PageScroll>;
}
