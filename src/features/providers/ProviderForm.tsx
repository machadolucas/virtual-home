"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createProvider, updateProvider } from "@/server/actions/maintenance/providers";
import type { ProviderInput } from "@/server/services/providers";
import { useAction } from "@/features/settings/actionClient";
import { Button, Checkbox, Field, Input, Textarea } from "@/ui";
export function ProviderForm({ initial, providerId, onSaved, compact = false }: {
  initial?: ProviderInput; providerId?: string; compact?: boolean;
  onSaved?: (provider: { id: string; name: string; trade: string | null; phone: string | null }) => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<ProviderInput>(initial ?? { name: "" });
  const save = useAction(providerId ? updateProvider : createProvider, { successTitle: "Provider saved", onSuccess: ({ providerId: id }) => {
    if (onSaved) onSaved({ id, name: form.name.trim(), trade: form.trade || null, phone: form.phone || null });
    else { router.push(`/providers/${id}`); router.refresh(); }
  }});
  const fields = [
    ["name", "Name", "text"], ["trade", "Trade or service", "text"], ["contactName", "Contact person", "text"],
    ["phone", "Phone", "tel"], ["email", "Email", "email"], ["website", "Website", "url"],
    ["address", "Address", "text"], ["vatId", "Business / VAT number", "text"],
  ] as const;
  return <form data-unsaved className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void save.run({ ...form, providerId }); }}>
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.filter(([key]) => !compact || ["name", "trade", "phone", "email"].includes(key)).map(([key, label, type]) => <Field key={key} label={label} required={key === "name"}>{({ id }) =>
        <Input id={id} type={type} required={key === "name"} value={form[key] ?? ""} maxLength={key === "website" || key === "address" ? 500 : key === "phone" || key === "trade" || key === "vatId" ? 80 : 200} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      }</Field>)}
    </div>
    {!compact && <><Field label="Notes">{({ id }) => <Textarea id={id} rows={3} maxLength={4000} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field><Checkbox label="Preferred provider" checked={form.isPreferred ?? false} onCheckedChange={(checked) => setForm({ ...form, isPreferred: checked === true })} /></>}
    {save.error && <p role="alert" className="text-sm text-overdue">{save.error}</p>}
    <div className="flex items-center gap-3"><Button type="submit" loading={save.pending} disabled={!form.name.trim()}>Save provider</Button>{!onSaved && <Link href={providerId ? `/providers/${providerId}` : "/providers"} className="text-sm text-ink-2">Cancel</Link>}</div>
  </form>;
}
