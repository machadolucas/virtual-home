"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAction } from "@/features/settings/actionClient";
import { deleteProject } from "@/server/actions/infrastructure/projects";
import { Button } from "@/ui";

/**
 * Deleting the project deletes the **container**: its links and its file links. Every record it
 * pointed at — the equipment, the completions, the routes — survives untouched, which is why this
 * is a plain confirm rather than a fresh-session gate.
 *
 * Two clicks, no dialog: the second click is the confirmation, and the label says exactly what
 * will and will not happen.
 */
export function DeleteProject({ projectId, name }: { projectId: string; name: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const remove = useAction(deleteProject, {
    successTitle: "Project deleted",
    onSuccess: () => router.push("/projects"),
  });

  if (!armed)
    return (
      <Button variant="ghost" size="sm" onClick={() => setArmed(true)}>
        Delete project
      </Button>
    );

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-2">
        Delete “{name}”? Its links and attached files are unlinked; nothing they point at is
        removed.
      </span>
      <Button
        variant="danger"
        size="sm"
        loading={remove.pending}
        onClick={() => remove.run({ id: projectId })}
      >
        Delete
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
        Keep
      </Button>
    </span>
  );
}
