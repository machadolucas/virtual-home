"use client";
/**
 * Creating a procedure: title, one line of summary, and nothing else — the rest is written in the
 * draft editor, which is where the work actually is.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button, Dialog, Field, Input } from "@/ui";
import { createProcedure } from "@/server/actions/maintenance/procedures";
import { messageFor, newRequestKey, useAction } from "./useAction";

export function NewProcedureButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [key] = useState(newRequestKey);
  const { run, pending, failure } = useAction(createProcedure, { refresh: false });

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        icon={<Plus aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        New procedure
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="New procedure"
        description="Creates an unpublished draft. Nothing uses it until you publish it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={title.trim() === ""}
              onClick={() =>
                void run({
                  title: title.trim(),
                  summary: summary.trim() === "" ? null : summary.trim(),
                  idempotencyKey: key,
                }).then((result) => {
                  if (result !== null) router.push(`/procedures/${result.procedureId}`);
                })
              }
            >
              Create the draft
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Title" required>
            {({ id }) => (
              <Input
                id={id}
                value={title}
                placeholder="Replace the ventilation filters"
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
          <Field label="Summary" help="One line, shown when picking a procedure for a plan.">
            {({ id }) => (
              <Input
                id={id}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            )}
          </Field>
          {failure !== null ? (
            <p className="text-sm text-overdue">{messageFor(failure)}</p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
