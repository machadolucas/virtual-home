"use client";

import Link from "next/link";
import { Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { EquipmentGroup, EquipmentListRow } from "@/server/queries/assets/list";
import { bulkRemoveEquipment } from "@/server/actions/assets/bulk";
import { useAction } from "@/features/settings/actionClient";
import {
  ASSET_STATUS_LABEL,
  ASSET_STATUS_TONE,
  CATEGORY_LABEL,
  LINK_STATE_META,
} from "@/features/assets/labels";
import { Badge, Button, Checkbox, Dialog, Input, Panel, StatusDot, cn } from "@/ui";

interface EquipmentListProps {
  groups: EquipmentGroup[];
  total: number;
}

const BULK_REMOVE_LIMIT = 1000;

function matches(row: EquipmentListRow, query: string): boolean {
  if (query === "") return true;
  return [
    row.name,
    row.manufacturer,
    row.modelName,
    row.locationName,
    row.locationPath,
    CATEGORY_LABEL[row.category],
  ]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLocaleLowerCase().includes(query));
}

export function EquipmentList({ groups, total }: EquipmentListProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(
    () =>
      groups.flatMap((group) => {
        const rows = group.rows.filter((row) => matches(row, normalizedQuery));
        return rows.length === 0 ? [] : [{ ...group, rows }];
      }),
    [groups, normalizedQuery],
  );
  const visibleRows = filteredGroups.flatMap((group) => group.rows);
  const everyVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.id));
  const someVisibleSelected = visibleRows.some((row) => selected.has(row.id));
  const rowsById = useMemo(
    () => new Map(groups.flatMap((group) => group.rows).map((row) => [row.id, row])),
    [groups],
  );
  const selectedRows = [...selected]
    .map((id) => rowsById.get(id))
    .filter((row): row is EquipmentListRow => row !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));

  const remove = useAction(bulkRemoveEquipment, {
    successTitle: "Equipment removed",
    successDescription: (data) =>
      `${data.removedCount} unit(s) were removed from the active list.`,
    messages: {
      equipment_changed:
        "The equipment list changed while this dialog was open. Nothing was removed; refresh and choose again.",
    },
    onSuccess: () => {
      setConfirmOpen(false);
      setSelected(new Set());
      router.refresh();
    },
  });

  function setRowSelected(id: string, checked: boolean | "indeterminate"): void {
    if (remove.pending) return;
    setSelected((current) => {
      const next = new Set(current);
      if (checked === true && next.size < BULK_REMOVE_LIMIT) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setVisibleSelected(checked: boolean | "indeterminate"): void {
    if (remove.pending) return;
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visibleRows) {
        if (checked === true) {
          if (next.size < BULK_REMOVE_LIMIT || next.has(row.id)) next.add(row.id);
        } else {
          next.delete(row.id);
        }
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4" aria-busy={remove.pending || undefined}>
      <div className="sticky top-0 z-10 flex flex-col gap-3 rounded-lg border border-line bg-surface/95 p-3 shadow-panel backdrop-blur sm:flex-row sm:items-center">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={remove.pending}
          placeholder="Filter equipment"
          aria-label="Filter equipment"
          icon={<Search />}
          className="sm:w-80"
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <Checkbox
            checked={
              everyVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
            }
            onCheckedChange={setVisibleSelected}
            disabled={remove.pending || visibleRows.length === 0}
            label={normalizedQuery === "" ? "Select all" : "Select all filtered"}
          />
          <span className="text-xs text-ink-3">
            {visibleRows.length} shown · {selected.size} selected · up to {BULK_REMOVE_LIMIT.toLocaleString()} per removal
          </span>
        </div>
        <Button
          variant="danger"
          icon={<Trash2 aria-hidden="true" />}
          disabled={selected.size === 0 || remove.pending}
          onClick={() => setConfirmOpen(true)}
        >
          Remove selected
        </Button>
      </div>

      {filteredGroups.length === 0 ? (
        <Panel>
          <p className="text-sm text-ink-2">No equipment matches “{query.trim()}”.</p>
        </Panel>
      ) : (
        filteredGroups.map((group) => (
          <Panel
            key={group.locationId ?? "__none"}
            flush
            title={group.locationName}
            subtitle={
              group.locationId === null
                ? "No location recorded. Software units belong here; a physical unit here needs a room."
                : `${group.rows.length} unit(s)`
            }
          >
            <ul className="flex list-none flex-col">
              {group.rows.map((row) => (
                <li
                  key={row.id}
                  className="flex min-h-16 items-stretch border-b border-line last:border-b-0"
                >
                  <div className="flex w-11 shrink-0 items-center justify-center pl-2">
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={(checked) => setRowSelected(row.id, checked)}
                      disabled={remove.pending}
                      ariaLabel={`Select ${row.name}`}
                    />
                  </div>
                  <Link
                    href={`/equipment/${row.id}`}
                    aria-disabled={remove.pending || undefined}
                    tabIndex={remove.pending ? -1 : undefined}
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-3 transition-colors duration-100",
                      "hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4",
                      "outline-none focus-visible:bg-surface-2 focus-visible:outline-2",
                      "focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      remove.pending && "pointer-events-none opacity-60",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{row.name}</span>
                        <Badge tone="neutral" size="sm">
                          {CATEGORY_LABEL[row.category]}
                        </Badge>
                        {row.status === "installed" ? null : (
                          <Badge tone={ASSET_STATUS_TONE[row.status]} size="sm">
                            {ASSET_STATUS_LABEL[row.status]}
                          </Badge>
                        )}
                        {row.isVirtual ? (
                          <Badge tone="neutral" size="sm">Software</Badge>
                        ) : null}
                      </span>
                      <span className="text-xs leading-5 text-ink-3">
                        {[row.manufacturer, row.modelName].filter(Boolean).join(" ") ||
                          "No manufacturer or model recorded."}
                      </span>
                    </span>

                    <span className="flex shrink-0 flex-wrap items-center gap-3 sm:w-80 sm:justify-end">
                      {row.openTaskCount === 0 ? null : (
                        <span className="flex items-center gap-1.5">
                          <StatusDot
                            kind={row.overdueTaskCount > 0 ? "due" : "unknown"}
                            label={row.overdueTaskCount > 0 ? `${row.overdueTaskCount} due now` : "open tasks"}
                          />
                          <span className="vh-tnum text-xs text-ink-2">{row.openTaskCount} open</span>
                        </span>
                      )}
                      {row.battery === null ? null : (
                        <span className="flex items-center gap-1.5">
                          <StatusDot kind={row.battery.status} label={null} />
                          <span className="vh-tnum text-xs font-medium text-ink-2">{row.battery.label}</span>
                        </span>
                      )}
                      {row.linkState === null ? (
                        <span className="hidden text-xs text-ink-3 md:inline">Not linked</span>
                      ) : (
                        <Badge tone={LINK_STATE_META[row.linkState].tone} size="sm">
                          {LINK_STATE_META[row.linkState].label}
                        </Badge>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ))
      )}

      <p className="text-xs leading-5 text-ink-3">
        {total} unit(s) in service or planned. A battery shown as “unknown” means no reading has
        arrived — never that the battery is empty. A link marked “Renamed in HA” still works: the
        binding is to the registry id, and only the label we cached is out of date.
      </p>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!remove.pending) setConfirmOpen(open);
        }}
        hideClose
        title={`Remove ${selectedRows.length} equipment unit(s)?`}
        description="They leave the active equipment list. Their service history and old Home Assistant links stay in the record."
        footer={
          <>
            <Button variant="ghost" disabled={remove.pending} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.pending}
              disabled={selectedRows.length === 0}
              onClick={() =>
                remove.run({
                  assetIds: selectedRows.map((row) => row.id),
                  idempotencyKey: remove.idempotencyKey,
                })
              }
            >
              Remove {selectedRows.length}
            </Button>
          </>
        }
      >
        <p>
          Removed equipment can be imported from Home Assistant again later. Importing creates a
          current equipment record; it does not erase this one.
        </p>
        <ul className="mt-3 max-h-56 list-disc overflow-y-auto pl-5 text-ink">
          {selectedRows.map((row) => (
            <li key={row.id}>{row.name}</li>
          ))}
        </ul>
        {remove.error === null ? null : (
          <p role="alert" className="mt-3 font-medium text-overdue">{remove.error}</p>
        )}
      </Dialog>
    </div>
  );
}
