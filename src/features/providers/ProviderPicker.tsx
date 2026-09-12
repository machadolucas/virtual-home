"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Dialog, Select } from "@/ui";
import { ProviderForm } from "./ProviderForm";
export interface ProviderChoice { value: string; label: string; hint?: string }
export function ProviderPicker({ value, onValueChange, options, id, describedBy, emptyValue = "", emptyLabel = "Choose provider…" }: {
  value: string; onValueChange: (value: string) => void; options: readonly ProviderChoice[];
  id?: string; describedBy?: string; emptyValue?: string; emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<ProviderChoice[]>([]);
  return <div className="flex flex-col gap-2"><Select id={id} describedBy={describedBy} value={value} onValueChange={onValueChange} options={[{ value: emptyValue, label: emptyLabel }, ...options, ...added.filter((o) => !options.some((p) => p.value === o.value))]} />
    <div className="flex flex-wrap gap-3 items-center"><Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>Add provider</Button><Link href="/providers" target="_blank" rel="noopener noreferrer" className="text-xs text-accent-text underline">Manage providers ↗</Link></div>
    <Dialog open={open} onOpenChange={setOpen} title="Add provider" description="You can add more contact details from Providers later."><ProviderForm compact onSaved={(provider) => { setAdded([...added, { value: provider.id, label: provider.name, hint: provider.trade ?? undefined }]); onValueChange(provider.id); setOpen(false); }} /></Dialog>
  </div>;
}
