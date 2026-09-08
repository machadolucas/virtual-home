"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, ArrowRightLeft, Check, PinOff, TriangleAlert } from "lucide-react";
import { Badge, Button, Dialog, Input, Select, toast } from "@/ui";
import { useAction } from "@/features/settings/actionClient";
import {
  DECISION_BLURB,
  DECISION_LABEL,
  RECONCILIATION_DECISIONS,
  RECONCILIATION_MESSAGES,
  applyConsequences,
  candidateHint,
  candidateLabel,
  countDecisions,
  decisionAvailable,
  decisionSummary,
  defaultRemapTarget,
  entityKindLabel,
  formatScore,
  issueLabel,
  summaryEntries,
  type Decision,
  type ItemView,
  type PlanView,
} from "@/features/settings/model/reconciliation";
import {
  abandonModelReconciliation,
  applyModelReconciliation,
  decideModelReconciliationItem,
} from "@/server/actions/settings/model";

/**
 * Deciding a reconciliation, row by row, and applying it.
 *
 * The shape of this screen follows D-016: an import never rewrites a row, so every row here is a
 * question, and the only irreversible button is "Apply" — which the server refuses
 * (`undecided_items`) until every question has an answer. The client mirrors that rule rather than
 * inventing its own: "Apply" stays disabled while anything is undecided, and the confirmation
 * spells out the consequences in counts rather than saying "this cannot be undone".
 *
 * A decision is deliberately cheap: it is recorded on the item, nothing touches the runtime
 * tables, and it can be changed as often as somebody likes until the plan is applied. That is why
 * the rows are optimistic — the answer appears at once and only rolls back if the server rejects
 * it (an identifier the new package does not have, a target another record already claims).
 */
export function ReconciliationPanel({ plans }: { plans: readonly PlanView[] }) {
  const open = plans.filter((plan) => plan.status === "open");
  const settled = plans.filter((plan) => plan.status !== "open");

  return (
    <div className="flex flex-col gap-6">
      {open.length === 0 ? (
        <p className="max-w-prose text-sm leading-6 text-ink-2">
          No reconciliation is open. One is created when an import finds rows referencing semantic
          identifiers the new package does not carry, and it waits for a decision per row — remap,
          keep, or archive. Until it is applied, the new revision stays imported and the house view
          keeps drawing the old one.
        </p>
      ) : (
        open.map((plan) => <OpenPlan key={plan.id} plan={plan} />)
      )}
      {settled.length === 0 ? null : <SettledPlans plans={settled} />}
    </div>
  );
}

/** The codes `action()` itself can return; `useAction` owns these for the other two calls. */
const GENERIC_MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Reload the page and sign in again.",
  invalid_request: "That is not a shape a semantic identifier can have. Check the spelling.",
  internal: "The server could not record that decision. Nothing was changed.",
  not_found: "That row is no longer part of this plan. Reload the page.",
};

interface Choice {
  decision: Decision;
  newNodeId: string | null;
}

function OpenPlan({ plan }: { plan: PlanView }) {
  const router = useRouter();
  // Decisions the server has accepted but this render has not seen yet, plus the one in flight.
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const items: ItemView[] = plan.items.map((item) => {
    const choice = choices[item.id];
    return choice === undefined
      ? item
      : { ...item, decision: choice.decision, decidedNewNodeId: choice.newNodeId };
  });
  const counts = countDecisions(items);

  /**
   * Hand-rolled rather than `useAction`, because rolling an optimistic decision back needs a
   * failure hook the shared hook does not offer. Everything else about it is the same: one code
   * mapped to one sentence, and a toast that says what did *not* change.
   */
  function decide(item: ItemView, decision: Decision, newNodeId: string | null) {
    setChoices((prev) => ({ ...prev, [item.id]: { decision, newNodeId } }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setBusyItemId(item.id);
    startTransition(async () => {
      const result = await decideModelReconciliationItem({
        itemId: item.id,
        decision,
        ...(newNodeId === null ? {} : { newNodeId }),
      });
      setBusyItemId(null);
      if (result.ok) {
        router.refresh();
        return;
      }
      setChoices((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      const message =
        RECONCILIATION_MESSAGES[result.error] ?? GENERIC_MESSAGES[result.error] ?? result.error;
      setErrors((prev) => ({ ...prev, [item.id]: message }));
      toast({ title: "Not decided", description: message, tone: "error", duration: 0 });
    });
  }

  return (
    <section className="flex flex-col gap-3" aria-label={`Reconciliation ${plan.fromLabel} to ${plan.toLabel}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone="due" size="sm">
          open
        </Badge>
        <span className="font-mono text-xs text-ink-3">
          {plan.fromLabel} → {plan.toLabel}
        </span>
        <span className="vh-tnum text-xs text-ink-3">
          {plan.total - counts.undecided} of {plan.total} decided · created{" "}
          {new Date(plan.createdAtMs).toISOString().slice(0, 10)}
        </span>
      </div>

      <dl className="flex list-none flex-col gap-1.5 rounded-md border border-line bg-surface-2/60 p-3">
        {RECONCILIATION_DECISIONS.map((decision) => (
          <div key={decision} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="min-w-20 text-xs font-semibold text-ink">{DECISION_LABEL[decision]}</dt>
            <dd className="max-w-prose text-xs leading-5 text-ink-3">{DECISION_BLURB[decision]}</dd>
          </div>
        ))}
      </dl>

      <div className="w-full overflow-x-auto rounded-md border border-line">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">
            Records affected by this reconciliation, and what to do about each one
          </caption>
          <thead>
            <tr className="border-b border-line">
              <Th>Record</Th>
              <Th>Old identifier</Th>
              <Th>Issue</Th>
              <Th>Candidates</Th>
              <Th>Decision</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                busy={busyItemId === item.id}
                error={errors[item.id] ?? null}
                onDecide={decide}
              />
            ))}
          </tbody>
        </table>
      </div>

      <PlanActions plan={plan} counts={counts} />
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3">
      {children}
    </th>
  );
}

/** Sentinel option: the candidate list is a shortlist, never the whole package. */
const TYPE_IT = "__type__";

function ItemRow({
  item,
  busy,
  error,
  onDecide,
}: {
  item: ItemView;
  busy: boolean;
  error: string | null;
  onDecide: (item: ItemView, decision: Decision, newNodeId: string | null) => void;
}) {
  const suggested = defaultRemapTarget(item);
  const known = item.candidates.some((candidate) => candidate.nodeId === suggested);
  const [target, setTarget] = useState(suggested === "" || !known ? TYPE_IT : suggested);
  const [typed, setTyped] = useState(known ? "" : suggested);

  const remapTarget = (target === TYPE_IT ? typed : target).trim();
  const decided = decisionSummary(item);
  const canArchive = decisionAvailable("archive", item.entityKind);

  const options = [
    ...item.candidates.map((candidate) => ({
      value: candidate.nodeId,
      label: candidateLabel(candidate),
      hint: candidateHint(candidate),
    })),
    { value: TYPE_IT, label: "Type an identifier…" },
  ];

  return (
    <tr className="border-b border-line/70 align-top last:border-b-0">
      <td className="px-3 py-2.5">
        <span className="block text-sm text-ink">{entityKindLabel(item.entityKind)}</span>
        <span className="block font-mono text-[0.6875rem] leading-4 text-ink-3">{item.entityId}</span>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-ink">{item.oldNodeId}</td>
      <td className="px-3 py-2.5">
        <Badge tone="neutral" size="sm">
          {issueLabel(item.issue)}
        </Badge>
        <span className="mt-1 block text-xs text-ink-3">
          proposed: {item.proposedAction}
          {item.proposedNewNodeId === null ? "" : ` → ${item.proposedNewNodeId}`}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {item.candidates.length === 0 ? (
          <span className="text-xs text-ink-3">
            Nothing in the new package resembles it. Keep it, or archive it.
          </span>
        ) : (
          <ul className="flex list-none flex-col gap-0.5">
            {item.candidates.map((candidate) => (
              <li key={candidate.nodeId} className="text-xs leading-5">
                <span className="font-mono text-ink-2">{candidate.nodeId}</span>{" "}
                <span className="vh-tnum text-ink-3">{formatScore(candidate.score)}</span>
                {candidate.centroidDistanceM === undefined ? null : (
                  <span className="vh-tnum text-ink-3"> · {candidate.centroidDistanceM.toFixed(2)} m</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="min-w-64 px-3 py-2.5">
        <div className="flex flex-col gap-2">
          {decided === null ? null : (
            <Badge tone="accent" size="sm" icon={<Check aria-hidden="true" />}>
              {decided}
            </Badge>
          )}
          <Select
            ariaLabel={`New identifier for ${entityKindLabel(item.entityKind)} ${item.entityId}`}
            value={target}
            onValueChange={setTarget}
            options={options}
            selectSize="sm"
          />
          {target === TYPE_IT ? (
            <Input
              inputSize="sm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="r-l-closet"
              aria-label={`Identifier to remap ${item.entityId} onto`}
              className="font-mono"
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={remapTarget === ""}
              icon={<ArrowRightLeft aria-hidden="true" />}
              onClick={() => onDecide(item, "remap", remapTarget)}
            >
              Remap
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              icon={<PinOff aria-hidden="true" />}
              onClick={() => onDecide(item, "keep", null)}
            >
              Keep
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              disabled={!canArchive}
              icon={<Archive aria-hidden="true" />}
              onClick={() => onDecide(item, "archive", null)}
            >
              Archive
            </Button>
          </div>
          {canArchive ? null : (
            <span className="text-xs leading-5 text-ink-3">
              A location anchors equipment, storage and history, so it is never archived.
            </span>
          )}
          {item.note === null ? null : (
            <span className="text-xs leading-5 text-ink-3">{item.note}</span>
          )}
          {item.decidedByName === null ? null : (
            <span className="text-xs leading-5 text-ink-3">decided by {item.decidedByName}</span>
          )}
          {error === null ? null : (
            <span role="alert" className="text-xs font-medium leading-5 text-overdue">
              {error}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function PlanActions({
  plan,
  counts,
}: {
  plan: PlanView;
  counts: ReturnType<typeof countDecisions>;
}) {
  const router = useRouter();
  const [applyOpen, setApplyOpen] = useState(false);
  const [abandonOpen, setAbandonOpen] = useState(false);

  const apply = useAction(applyModelReconciliation, {
    successTitle: "Reconciliation applied",
    successDescription: (data) =>
      `${data.applied.remap} remapped, ${data.applied.keep} kept, ${data.applied.archive} archived` +
      (data.flaggedMoves.length === 0
        ? "."
        : `; ${data.flaggedMoves.length} position(s) moved more than 2 m and are flagged for review.`),
    messages: RECONCILIATION_MESSAGES,
    onSuccess: () => {
      setApplyOpen(false);
      router.refresh();
    },
  });
  const abandon = useAction(abandonModelReconciliation, {
    successTitle: "Reconciliation abandoned",
    successDescription: () =>
      "The new revision stays imported and the affected rows stay flagged. A later import starts a fresh plan.",
    messages: RECONCILIATION_MESSAGES,
    onSuccess: () => {
      setAbandonOpen(false);
      router.refresh();
    },
  });

  const ready = counts.undecided === 0;
  const decided = counts.remap + counts.keep + counts.archive;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        trigger={
          <Button variant="primary" size="sm" disabled={!ready} icon={<Check aria-hidden="true" />}>
            Apply
          </Button>
        }
        title="Apply this reconciliation?"
        description="One transaction. This is the step that moves the current revision."
        footer={
          <>
            <Button variant="ghost" onClick={() => setApplyOpen(false)} disabled={apply.pending}>
              Cancel
            </Button>
            <Button
              loading={apply.pending}
              onClick={() =>
                apply.run({ reconciliationId: plan.id, idempotencyKey: apply.idempotencyKey })
              }
            >
              Apply it
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm leading-6 text-ink-2">
          <ul className="flex list-none flex-col gap-2">
            {applyConsequences(counts).map((line, index) => (
              <li key={index} className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-ink-3" />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
          {apply.error === null ? null : (
            <p role="alert" className="text-sm font-medium text-overdue">
              {apply.error}
            </p>
          )}
        </div>
      </Dialog>

      <Dialog
        open={abandonOpen}
        onOpenChange={setAbandonOpen}
        trigger={
          <Button variant="secondary" size="sm">
            Abandon
          </Button>
        }
        title="Abandon this reconciliation?"
        description="Nothing is applied and nothing is cleaned up."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAbandonOpen(false)} disabled={abandon.pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={abandon.pending}
              onClick={() =>
                abandon.run({ reconciliationId: plan.id, idempotencyKey: abandon.idempotencyKey })
              }
            >
              Abandon it
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm leading-6 text-ink-2">
          <p>
            The new revision stays <span className="font-mono text-xs">imported</span>, the house
            view keeps drawing the current one, and the household pointer does not move.
          </p>
          <p>
            The affected rows <strong className="font-semibold">stay flagged</strong>: they still
            point at identifiers the newest package does not have, which is a true statement about
            them either way. The {decided} decision(s) already recorded are kept as the record
            of what was being considered; a later import starts a fresh plan.
          </p>
          {abandon.error === null ? null : (
            <p role="alert" className="text-sm font-medium text-overdue">
              {abandon.error}
            </p>
          )}
        </div>
      </Dialog>

      {ready ? (
        <span className="text-xs text-ink-3">
          {counts.remap} to remap, {counts.keep} to keep, {counts.archive} to archive.
        </span>
      ) : (
        <span className="text-xs text-ink-3">
          {counts.undecided} row(s) still need an answer before this can be applied.
        </span>
      )}
    </div>
  );
}

/** Applied and abandoned plans, with the counts their `summary_json` recorded. */
function SettledPlans({ plans }: { plans: readonly PlanView[] }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-ink">Earlier reconciliations</h3>
      <ul className="flex list-none flex-col divide-y divide-line rounded-md border border-line">
        {plans.map((plan) => {
          const entries = summaryEntries(plan.summary);
          return (
            <li key={plan.id} className="flex flex-col gap-1 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={plan.status === "applied" ? "accent" : "neutral"} size="sm">
                  {plan.status}
                </Badge>
                <span className="font-mono text-xs text-ink-3">
                  {plan.fromLabel} → {plan.toLabel}
                </span>
                <span className="vh-tnum text-xs text-ink-3">
                  {plan.status === "applied" && plan.appliedAtMs !== null
                    ? `applied ${new Date(plan.appliedAtMs).toISOString().slice(0, 10)}`
                    : `created ${new Date(plan.createdAtMs).toISOString().slice(0, 10)}`}
                </span>
              </div>
              {entries.length === 0 ? (
                <span className="text-xs text-ink-3">No counts were recorded.</span>
              ) : (
                <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
                  {entries.map((entry) => (
                    <div key={entry.key} className="flex items-baseline gap-1">
                      <dt className="vh-tnum text-xs font-semibold text-ink-2">{entry.value}</dt>
                      <dd className="text-xs text-ink-3">{entry.label}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
