"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { PartUnit, StockTransactionReason } from "@/db/schema";
import { Button, Dialog, Field, Select, Textarea } from "@/ui";
import { CORRECTION_REASONS } from "@/features/inventory/labels";
import { formatSignedQuantity } from "@/features/inventory/units";
import { useAction } from "@/features/settings/actionClient";
import { correctTransaction } from "@/server/actions/inventory/stock";

/**
 * Correct one ledger row.
 *
 * The word is "correct", not "delete" or "edit", because that is what happens: a mirror row is
 * appended pointing at the original. Both stay visible. A reason is mandatory — a correction
 * nobody explained is a hole in the history, and the database allows a row to be corrected exactly
 * once, so the explanation is the only chance to say why.
 */
export function CorrectRow({
  partId,
  transactionId,
  qtyMilli,
  unit,
  isKit,
  describe,
}: {
  partId: string;
  transactionId: string;
  qtyMilli: number;
  unit: PartUnit;
  isKit: boolean;
  /** One line naming the movement, so the dialog is unambiguous. */
  describe: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<StockTransactionReason>("manual_correction");
  const [notes, setNotes] = useState("");

  const call = useAction(correctTransaction, {
    successTitle: "Correction recorded",
    successDescription: () =>
      "A mirror movement was appended. The original row stays in the ledger.",
    onSuccess: () => {
      setOpen(false);
      setNotes("");
      router.refresh();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      /* Every row in the ledger has one of these; without the movement in the accessible name they
         are a column of buttons all called "Correct". */
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Correct ${describe}`}
          icon={<RotateCcw aria-hidden="true" />}
        >
          Correct
        </Button>
      }
      title="Correct this movement"
      description="Nothing is deleted. A mirror movement is appended, pointing at the original, and both stay visible."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={call.pending}
            disabled={notes.trim() === ""}
            onClick={() =>
              call.run({
                partId,
                transactionId,
                reason,
                notes,
                idempotencyKey: call.idempotencyKey,
              })
            }
          >
            Record the correction
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-6 text-ink-2">
          {describe} —{" "}
          <strong className="vh-tnum font-semibold text-ink">
            {formatSignedQuantity(qtyMilli, unit, isKit)}
          </strong>
          . The correction will be{" "}
          <strong className="vh-tnum font-semibold text-ink">
            {formatSignedQuantity(-qtyMilli, unit, isKit)}
          </strong>
          .
        </p>

        <Field label="What went wrong" required>
          {({ id }) => (
            <Select
              id={id}
              value={reason}
              onValueChange={(value) => setReason(value as StockTransactionReason)}
              options={CORRECTION_REASONS.map((entry) => ({
                value: entry.value,
                label: entry.label,
                hint: entry.hint,
              }))}
            />
          )}
        </Field>

        <Field
          label="In your own words"
          required
          help="This is the only explanation the history will ever have."
          error={call.fieldErrors["notes"]?.[0]}
        >
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Entered against the wrong item — it was the bathroom filter."
            />
          )}
        </Field>

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
