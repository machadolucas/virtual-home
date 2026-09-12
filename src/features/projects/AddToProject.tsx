"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectLinkEntityKind } from "@/db/schema/infrastructure";
import { addProjectLink } from "@/server/actions/infrastructure/projects";
import { useAction } from "@/features/settings/actionClient";
import { Button, Dialog, Field } from "@/ui";
import { RecordPicker } from "./RecordPicker";
export function AddToProject({ entityKind, entityId }: { entityKind: ProjectLinkEntityKind; entityId: string }) {
  const router = useRouter(), [open, setOpen] = useState(false), [projectId, setProjectId] = useState("");
  const save = useAction(addProjectLink, { successTitle: "Added to project", messages: { link_exists: "This record is already linked to that project." }, onSuccess: () => { setOpen(false); router.refresh(); } });
  return <Dialog open={open} onOpenChange={(next) => { if (!save.pending) setOpen(next); }} title="Add to project" trigger={<Button type="button" variant="ghost" size="sm">Add to project</Button>} footer={<Button disabled={!projectId} loading={save.pending} onClick={() => save.run({ projectId, entityKind, entityId, role: null })}>Add link</Button>}><Field label="Project">{({ id }) => <RecordPicker kind="project" id={id} value={projectId} onChange={setProjectId} />}</Field>{save.error && <p role="alert" className="mt-3 text-sm text-overdue">{save.error}</p>}</Dialog>;
}
