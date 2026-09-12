"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { archiveProvider } from "@/server/actions/maintenance/providers";
import { useAction } from "@/features/settings/actionClient";
import { Button, Dialog } from "@/ui";
export function ArchiveProvider({ providerId, archived }: { providerId: string; archived: boolean }) {
  const router = useRouter(), [open, setOpen] = useState(false);
  const save = useAction(archiveProvider, { successTitle: archived ? "Provider restored" : "Provider archived", onSuccess: () => { setOpen(false); router.refresh(); } });
  return <Dialog open={open} onOpenChange={setOpen} title={archived ? "Restore provider?" : "Archive provider?"} description={archived ? "Makes this provider available for new plans and bookings again." : "Removes this provider from new choices and clears their usual-provider setting on plans. Existing bookings, documents and history remain linked."} trigger={<Button size="sm" variant="secondary">{archived ? "Restore" : "Archive"}</Button>} footer={<Button loading={save.pending} onClick={() => save.run({ providerId, archived: !archived })}>{archived ? "Restore provider" : "Archive provider"}</Button>}>{save.error && <p role="alert">{save.error}</p>}</Dialog>;
}
