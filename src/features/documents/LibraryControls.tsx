"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui";
import { AssetUploader } from "@/features/assets/AssetUploader";
import { ServiceDocumentForm } from "./ServiceDocumentForm";
export type DocumentTargets = { equipment: {id:string;name:string}[]; projects: {id:string;name:string}[]; providers: {id:string;name:string}[]; bookings: {id:string;name:string}[]; completions: {id:string;name:string}[] };
export function LibraryControls({ targets }: { targets: DocumentTargets }) {
  const router = useRouter(); const [creating, setCreating] = useState(false);
  return <div className="flex flex-wrap gap-2"><AssetUploader accept="application/pdf,image/*" label="Upload document" inputLabel="Choose document" onUploaded={file => router.push(`/documents/${file.id}`)} /><Button data-discard-editor={creating || undefined} onClick={() => setCreating(v => !v)}>{creating ? "Cancel service record" : "New service record"}</Button>{creating && <div className="w-full"><ServiceDocumentForm targets={targets} /></div>}</div>;
}
