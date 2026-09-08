import Link from "next/link";
import { Badge, Panel, buttonClasses } from "@/ui";
import {
  describeSource,
  formatQty,
  type MaterialLine,
} from "@/features/maintenance/materials";
import { WaitingForMaterialsButton } from "@/features/maintenance/TaskActions";

/**
 * What this task needs, and whether the shelf actually has it.
 *
 * The balance shown is the ledger sum — the same number the completion transaction checks against
 * — so "enough in stock" here and "insufficient stock" on submit cannot disagree for any reason
 * other than somebody consuming a part in between, which is exactly the case §5.3 handles.
 */
export function MaterialsPanel({
  occurrenceId,
  materials,
  open,
}: {
  occurrenceId: string;
  materials: readonly MaterialLine[];
  /** Closed tasks show the list for reference but offer no "waiting" affordance. */
  open: boolean;
}) {
  if (materials.length === 0) {
    return (
      <Panel title="Materials">
        <p className="text-sm text-ink-3">
          Nothing is expected for this task. If it turns out to need a part, add it on the
          completion form or to the plan.
        </p>
      </Panel>
    );
  }

  const short = materials.filter((line) => line.availableMilli < line.expectedQtyMilli);

  return (
    <Panel
      title="Materials"
      subtitle="Pre-filled on the completion form; quantities are editable there."
      flush
      footer={
        short.length === 0 ? (
          "Everything this task needs is in stock."
        ) : (
          <span className="text-blocked">
            {short.length} {short.length === 1 ? "part is" : "parts are"} short. The completion form
            will ask what to do rather than guessing.
          </span>
        )
      }
    >
      <ul>
        {materials.map((line) => {
          const enough = line.availableMilli >= line.expectedQtyMilli;
          return (
            <li
              key={line.partId}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="text-sm text-ink">
                  {line.partName}
                  {line.isRequired ? "" : " (optional)"}
                </p>
                <p className="text-xs text-ink-3">
                  {[line.spec, describeSource(line.source)]
                    .filter((piece): piece is string => piece !== null && piece.length > 0)
                    .join(" · ")}
                </p>
              </div>
              <p className="vh-tnum flex items-center gap-2 text-sm">
                <span className="text-ink-2">{formatQty(line.expectedQtyMilli, line.unit)}</span>
                <Badge tone={enough ? "ok" : "blocked"} size="sm">
                  {formatQty(line.availableMilli, line.unit)} in stock
                </Badge>
              </p>
            </li>
          );
        })}
      </ul>
      {open && short.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <WaitingForMaterialsButton
            occurrenceId={occurrenceId}
            partNames={short.map((line) => line.partName)}
          />
          <Link href="/supplies" className={buttonClasses({ variant: "ghost", size: "sm" })}>
            Open Supplies
          </Link>
        </div>
      ) : null}
    </Panel>
  );
}
