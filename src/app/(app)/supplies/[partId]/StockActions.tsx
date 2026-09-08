"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Boxes,
  ClipboardList,
  Gauge,
  PackagePlus,
  Undo2,
} from "lucide-react";
import type { PartTrackingMode, PartUnit } from "@/db/schema";
import { Button, Dialog, Field, Input, Select, Textarea } from "@/ui";
import { KIT_RULE_TEXT } from "@/features/inventory/labels";
import { formatQuantity, parseQuantityToMilli, readPrice } from "@/features/inventory/units";
import { useAction } from "@/features/settings/actionClient";
import {
  addPurchase,
  explodeKit,
  setEstimate,
  stockTake,
  undoExplode,
} from "@/server/actions/inventory/stock";

export interface StockActionsProps {
  partId: string;
  partName: string;
  unit: PartUnit;
  isKit: boolean;
  trackingMode: PartTrackingMode;
  onHandMilli: number;
  componentCount: number;
  storagePlaces: readonly { value: string; label: string }[];
  lots: readonly { value: string; label: string; hint?: string }[];
  /** Open lot with a known full size — the only lot an estimate can be set on. */
  estimateLot: { id: string; label: string; estimatePct: number | null } | null;
  undoableGroups: readonly { groupId: string; occurredAtMs: number; kitQtyMilli: number }[];
  today: string;
}

const NO_LOT = "__none";

/**
 * The five movements a person can record by hand, each behind a dialog.
 *
 * Dialogs rather than an inline form, because each one asks two or three questions and the page
 * behind it is a ledger somebody is reading. A stock take asks for the **count**, not the
 * difference — working out the delta is the ledger's job, and asking a human to do subtraction is
 * how a stock take becomes wrong.
 */
export function StockActions(props: StockActionsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PurchaseDialog {...props} />
      <StockTakeDialog {...props} />
      {props.isKit ? <ExplodeDialog {...props} /> : null}
      {props.isKit && props.undoableGroups.length > 0 ? <UndoDialog {...props} /> : null}
      {props.trackingMode === "estimated" ? <EstimateDialog {...props} /> : null}
    </div>
  );
}

function PurchaseDialog(props: StockActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("1");
  const [lotId, setLotId] = useState(NO_LOT);
  const [placeId, setPlaceId] = useState(NO_LOT);
  const [priceText, setPriceText] = useState("");
  const [occurredOn, setOccurredOn] = useState(props.today);
  const [notes, setNotes] = useState("");

  const price = readPrice(priceText);

  const call = useAction(addPurchase, {
    successTitle: "Purchase recorded",
    successDescription: (data) =>
      `${formatQuantity(data.qtyMilli, props.unit, props.isKit)} added to ${props.partName}.`,
    onSuccess: () => {
      setOpen(false);
      setQty("1");
      setPriceText("");
      setNotes("");
      router.refresh();
    },
  });

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" size="sm" icon={<PackagePlus aria-hidden="true" />}>
          Add purchase
        </Button>
      }
      title="Record a purchase"
      description="Goods arrived. This adds to the ledger; it does not place an order."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={price.error !== null || parseQuantityToMilli(qty) === null}
            onClick={() =>
              call.run({
                partId: props.partId,
                qtyMilli: parseQuantityToMilli(qty) ?? 0,
                lotId: lotId === NO_LOT ? null : lotId,
                storagePlaceId: placeId === NO_LOT ? null : placeId,
                unitPriceCents: price.cents,
                occurredOn: occurredOn === "" ? undefined : occurredOn,
                notes,
                idempotencyKey: call.idempotencyKey,
              })
            }
          >
            Record it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="How much arrived"
          required
          help={`In ${props.unit}. ${props.trackingMode === "discrete" ? "Whole units only." : "Decimals are fine."}`}
          error={fieldError("qtyMilli")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              inputMode="decimal"
              autoFocus
              trailing={<span className="text-xs text-ink-3">{props.unit}</span>}
            />
          )}
        </Field>

        {props.lots.length === 0 ? null : (
          <Field
            label="Which lot"
            help="Leave unset if this arrival is not a tracked lot."
            error={fieldError("lotId")}
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                value={lotId}
                onValueChange={setLotId}
                options={[{ value: NO_LOT, label: "No particular lot" }, ...props.lots]}
              />
            )}
          </Field>
        )}

        {props.storagePlaces.length === 0 ? null : (
          <Field
            label="Where it went"
            help="Defaults to the item's usual place."
            error={fieldError("storagePlaceId")}
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                value={placeId}
                onValueChange={setPlaceId}
                options={[{ value: NO_LOT, label: "The usual place" }, ...props.storagePlaces]}
              />
            )}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Unit price"
            help="Optional. Per unit, not per order."
            error={price.error ?? undefined}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={priceText}
                onChange={(event) => setPriceText(event.target.value)}
                inputMode="decimal"
                placeholder="12,90"
              />
            )}
          </Field>
          <Field
            label="When it arrived"
            help="Backdating is fine; the ledger records both dates."
            error={fieldError("occurredOn")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                type="date"
                value={occurredOn}
                max={props.today}
                onChange={(event) => setOccurredOn(event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field
          label="Note"
          error={fieldError("notes")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Bought two so there is a spare."
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

function StockTakeDialog(props: StockActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");

  const call = useAction(stockTake, {
    successTitle: "Counted",
    successDescription: (data) =>
      data.matched
        ? "The shelf matched the ledger. Nothing was changed."
        : `Recorded a difference of ${formatQuantity(data.deltaMilli, props.unit, props.isKit)}.`,
    onSuccess: () => {
      setOpen(false);
      setCounted("");
      setNotes("");
      router.refresh();
    },
  });

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  const countedMilli = parseQuantityToMilli(counted);
  const delta = countedMilli === null ? null : countedMilli - props.onHandMilli;

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" size="sm" icon={<ClipboardList aria-hidden="true" />}>
          Stock take
        </Button>
      }
      title="Count what is actually there"
      description="Type what is on the shelf. The difference is what gets written to the ledger — the recorded number is never overwritten."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={countedMilli === null}
            onClick={() =>
              call.run({
                partId: props.partId,
                countedMilli: countedMilli ?? 0,
                notes,
                idempotencyKey: call.idempotencyKey,
              })
            }
          >
            Record the count
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-6 text-ink-2">
          The ledger currently says{" "}
          <strong className="vh-tnum font-semibold text-ink">
            {formatQuantity(props.onHandMilli, props.unit, props.isKit)}
          </strong>
          .
        </p>

        <Field
          label="What you counted"
          required
          help={`In ${props.unit}.`}
          error={fieldError("countedMilli")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              value={counted}
              onChange={(event) => setCounted(event.target.value)}
              inputMode="decimal"
              autoFocus
              trailing={<span className="text-xs text-ink-3">{props.unit}</span>}
            />
          )}
        </Field>

        {delta === null ? null : delta === 0 ? (
          <p className="text-sm text-ink-3">
            That matches. Nothing will be written to the ledger, but the count is recorded in the
            audit trail — which is what makes the number trustworthy.
          </p>
        ) : (
          <p className="vh-tnum text-sm font-medium text-ink">
            A difference of {formatQuantity(delta, props.unit, props.isKit)} will be recorded.
          </p>
        )}

        <Field
          label="Why the difference"
          help="Worth a sentence when the count is a surprise."
          error={fieldError("notes")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Two were used last spring and never recorded."
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

function ExplodeDialog(props: StockActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState("1");

  const call = useAction(explodeKit, {
    successTitle: "Kit opened",
    successDescription: (data) => `Its ${data.componentPartIds.length} contents now carry the stock.`,
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const kitsAvailable = props.onHandMilli / 1000;
  // `parseInt(count, 10) || 1` turned "", "0" and "abc" into one box and wrote a real explode
  // group for it. A box count nobody typed is not a default, it is a guess about stock.
  const boxes = readBoxCount(count);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="secondary"
          size="sm"
          icon={<Boxes aria-hidden="true" />}
          disabled={props.componentCount === 0}
        >
          Open a kit
        </Button>
      }
      title="Open a kit"
      description={KIT_RULE_TEXT}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={boxes === null}
            onClick={() => {
              if (boxes === null) return;
              call.run({
                kitPartId: props.partId,
                count: boxes,
                idempotencyKey: call.idempotencyKey,
              });
            }}
          >
            Open it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-6 text-ink-2">
          One box leaves this item and its {props.componentCount} contents arrive on their own
          items, in a single movement you can undo. Nothing is counted twice, which is why
          &ldquo;how many filters do I have&rdquo; stays one number.
        </p>

        <Field
          label="How many boxes"
          required
          help={`${kitsAvailable} on hand. Opening more than you have is allowed and shows as a negative — but it usually means a stock take is overdue.`}
          error={
            count.trim() === "" || boxes !== null
              ? undefined
              : "A whole number of boxes, at least one."
          }
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              value={count}
              onChange={(event) => setCount(event.target.value)}
              inputMode="numeric"
              autoFocus
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

function UndoDialog(props: StockActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const first = props.undoableGroups[0];
  const [groupId, setGroupId] = useState(first?.groupId ?? "");

  const call = useAction(undoExplode, {
    successTitle: "Kit re-sealed",
    successDescription: (data) => `${data.rowCount} movement(s) mirrored.`,
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  if (first === undefined) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm" icon={<Undo2 aria-hidden="true" />}>
          Undo opening
        </Button>
      }
      title="Undo opening a kit"
      description="Writes the mirror image of that movement: the box comes back and its contents leave. The original rows stay in the ledger."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            onClick={() =>
              call.run({
                kitPartId: props.partId,
                groupId,
                idempotencyKey: call.idempotencyKey,
              })
            }
          >
            Undo it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Which opening"
          required
          error={fieldError("groupId")}
        >
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              describedBy={describedBy}
              invalid={invalid}
              value={groupId}
              onValueChange={setGroupId}
              options={props.undoableGroups.map((group) => ({
                value: group.groupId,
                label: `${formatQuantity(-group.kitQtyMilli, props.unit, true)} on ${new Date(group.occurredAtMs).toISOString().slice(0, 10)}`,
                hint: `Group ${group.groupId.slice(0, 8)}`,
              }))}
            />
          )}
        </Field>
        <p className="text-sm text-ink-3">
          Only an opening that has not been undone appears here — a movement can be reversed once,
          and the database enforces that rather than trusting this list.
        </p>
        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function EstimateDialog(props: StockActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const lot = props.estimateLot;
  const [pct, setPct] = useState(lot?.estimatePct ?? 50);

  const call = useAction(setEstimate, {
    successTitle: "Estimate saved",
    successDescription: (data) =>
      `${data.estimatePct ?? 0} % — the ledger now reads ${formatQuantity(data.remainingMilli, props.unit, false)}.`,
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  if (lot === null) {
    return (
      <Button variant="secondary" size="sm" icon={<Gauge aria-hidden="true" />} disabled>
        Set estimate
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" size="sm" icon={<Gauge aria-hidden="true" />}>
          Set estimate
        </Button>
      }
      title="How much is left?"
      description="For something you cannot weigh: judge it by eye and the ledger records the implied change, so the two never drift apart."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            onClick={() =>
              call.run({ partId: props.partId, lotId: lot.id, estimatePct: pct })
            }
          >
            Save the estimate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">
          Lot <strong className="font-semibold text-ink">{lot.label}</strong>
        </p>

        {/* A native range input: it is the one control where the platform's keyboard support
            (arrows, Home/End, Page Up/Down) is already exactly right. */}
        <div className="flex flex-col gap-2">
          <label htmlFor="estimate-range" className="text-[0.8125rem] font-medium text-ink-2">
            Remaining
          </label>
          <div className="flex items-center gap-3">
            <input
              id="estimate-range"
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              onChange={(event) => setPct(Number.parseInt(event.target.value, 10))}
              className="h-11 flex-1 accent-accent"
              aria-describedby="estimate-value"
            />
            <output
              id="estimate-value"
              className="vh-tnum w-14 text-right text-sm font-semibold text-ink"
            >
              {pct} %
            </output>
          </div>
          <p className="text-xs leading-5 text-ink-3">
            In steps of five, because nobody can tell 43 % from 45 % by looking at a bottle.
          </p>
        </div>

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** `"2"` → `2`. `null` for anything that is not a whole number of boxes — never a defaulted 1. */
function readBoxCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : null;
}
