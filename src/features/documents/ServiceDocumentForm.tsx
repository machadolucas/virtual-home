"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui";
import { editServiceDocument, removeServiceDocument } from "@/server/actions/documents";
import { SERVICE_DOCUMENT_KINDS, type serviceDocument } from "@/db/schema/maintenance";
import { useAction } from "@/features/settings/actionClient";
import { AssetUploader } from "@/features/assets/AssetUploader";
import type { DocumentTargets } from "./LibraryControls";
const field = "block min-h-11 w-full rounded border border-line bg-surface px-3";
export function ServiceDocumentForm({ targets, initial, attachmentId: defaultAttachment }: { targets: DocumentTargets; initial?: typeof serviceDocument.$inferSelect; attachmentId?: string }) {
  const router = useRouter();
  const [attachmentId, setAttachmentId] = useState(initial?.attachmentId ?? defaultAttachment ?? null);
  const save = useAction(editServiceDocument, { successTitle: "Service record saved", onSuccess: result => router.push(`/documents/${result.id}`) });
  const remove = useAction(removeServiceDocument, { successTitle: "Service record removed. Original file retained.", onSuccess: () => router.push("/documents") });
  return <form data-unsaved className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const val = (key: string) => String(data.get(key) ?? "").trim() || null; save.run({ id: initial?.id, expectedUpdatedAtMs: initial?.updatedAtMs, kind: String(data.get("kind")) as typeof SERVICE_DOCUMENT_KINDS[number], attachmentId, providerId: val("providerId"), assetId: val("assetId"), bookingId: val("bookingId"), completionId: val("completionId"), documentNo: val("documentNo"), issuedOn: val("issuedOn"), validUntil: val("validUntil"), amountCents: val("amount") === null ? null : Math.round(Number(data.get("amount")) * 100), currency: String(data.get("currency") ?? "EUR"), notes: val("notes") }); }}>
    <label>Kind<select name="kind" defaultValue={initial?.kind ?? "invoice"} className={field}>{SERVICE_DOCUMENT_KINDS.map(kind => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</select></label>
    <label>Document number<input name="documentNo" defaultValue={initial?.documentNo ?? ""} className={field} /></label>
    <p className="text-sm text-ink-2 sm:col-span-2">Link this record to equipment, a booking or a completion. Choose at least one.</p>
    {([ ["assetId", "Equipment", targets.equipment], ["bookingId", "Booking", targets.bookings], ["completionId", "Completion", targets.completions], ["providerId", "Provider", targets.providers] ] as const).map(([name,label,items]) => <label key={name}>{label}<select name={name} defaultValue={initial?.[name] ?? ""} className={field}><option value="">None</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>)}
    <label>Issued on<input type="date" name="issuedOn" defaultValue={initial?.issuedOn ?? ""} className={field} /></label><label>Valid until<input type="date" name="validUntil" defaultValue={initial?.validUntil ?? ""} className={field} /></label>
    <label>Amount<input type="number" min="0" step="0.01" name="amount" defaultValue={initial?.amountCents == null ? "" : initial.amountCents / 100} className={field} /></label><label>Currency<input name="currency" pattern="[A-Z]{3}" maxLength={3} defaultValue={initial?.currency ?? "EUR"} className={field} /></label>
    <label className="sm:col-span-2">Notes<textarea name="notes" defaultValue={initial?.notes ?? ""} className={field} /></label>
    <div className="flex items-center gap-2 sm:col-span-2"><AssetUploader accept="application/pdf,image/*" label={attachmentId ? "Replace attached file" : "Attach file"} inputLabel="Choose service document file" onUploaded={file => setAttachmentId(file.id)} />{attachmentId && <span className="text-sm">File attached</span>}</div>
    {(save.error || remove.error) && <p role="alert" className="text-overdue sm:col-span-2">{save.error ?? remove.error}. Check the selected record and required fields.</p>}
    <div className="flex gap-2 sm:col-span-2"><Button type="submit" loading={save.pending}>Save service record</Button>{initial && <Button variant="danger" loading={remove.pending} onClick={() => { if (window.confirm("Remove this service record? Its original file will be kept.")) remove.run({ id: initial.id }); }}>Remove record</Button>}</div>
  </form>;
}

export function ServiceDocumentDetails({ record, targets }: { record: typeof serviceDocument.$inferSelect; targets: DocumentTargets }) {
  const [editing,setEditing]=useState(false);
  if(editing) return <div className="space-y-3"><Button data-discard-editor variant="ghost" onClick={()=>setEditing(false)}>Cancel editing</Button><ServiceDocumentForm initial={record} targets={targets}/></div>;
  const provider=targets.providers.find(p=>p.id===record.providerId);
  const equipment=targets.equipment.find(p=>p.id===record.assetId);
  const booking=targets.bookings.find(p=>p.id===record.bookingId);
  const completed=targets.completions.find(p=>p.id===record.completionId);
  return <div className="space-y-4"><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"><dt>Kind</dt><dd>{record.kind}</dd>{record.documentNo && <><dt>Document number</dt><dd>{record.documentNo}</dd></>}{provider && <><dt>Provider</dt><dd><Link className="text-accent-text underline" href={`/providers/${provider.id}`}>{provider.name}</Link></dd></>}{equipment && <><dt>Equipment</dt><dd><Link className="text-accent-text underline" href={`/equipment/${equipment.id}`}>{equipment.name}</Link></dd></>}{booking && <><dt>Booking</dt><dd>{booking.name}</dd></>}{completed && <><dt>Completion</dt><dd><Link className="text-accent-text underline" href={`/history?completion=${completed.id}`}>{completed.name}</Link></dd></>}{record.issuedOn && <><dt>Issued</dt><dd>{record.issuedOn}</dd></>}{record.validUntil && <><dt>Valid until</dt><dd>{record.validUntil}</dd></>}{record.amountCents !== null && <><dt>Amount</dt><dd>{(record.amountCents/100).toFixed(2)} {record.currency}</dd></>}</dl>{record.notes && <div className="whitespace-pre-wrap text-sm leading-6">{record.notes}</div>}<Button onClick={()=>setEditing(true)}>Edit service record</Button></div>;
}
