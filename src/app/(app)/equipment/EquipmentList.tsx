"use client";

import Link from "next/link";
import { Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { EquipmentGroup, EquipmentListRow } from "@/server/queries/assets/list";
import { bulkRemoveEquipment } from "@/server/actions/assets/bulk";
import { permanentlyDeleteEquipment } from "@/server/actions/assets/trash";
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
  mode?: "active" | "trash";
  blockers?: Record<string, string>;
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

export function EquipmentList({
  groups,
  total,
  mode = "active",
  blockers = {},
}: EquipmentListProps) {
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
  const visibleRows = filteredGroups
    .flatMap((group) => group.rows)
    .filter((row) => mode === "active" || blockers[row.id] === undefined);
  const everyVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.id));
  const someVisibleSelected = visibleRows.some((row) => selected.has(row.id));
  const rowsById = useMemo(
    () => new Map(groups.flatMap((group) => group.rows).map((row) => [row.id, row])),
    [groups],
  );
  const selectedRows = [...selected]
    .map((id) => rowsById.get(id))
    .filter(
      (row): row is EquipmentListRow =>
        row !== undefined && (mode === "active" || blockers[row.id] === undefined),
    )
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
  const permanentlyDelete = useAction(permanentlyDeleteEquipment, {
    successTitle: "Equipment permanently deleted",
    successDescription: (data) => `${data.deletedCount} unused record(s) were deleted.`,
    messages: {
      equipment_not_deletable:
        "The trash changed or one of these records now has history. Nothing was deleted; refresh and choose again.",
    },
    onSuccess: () => {
      setConfirmOpen(false);
      setSelected(new Set());
      router.refresh();
    },
  });
  const pending = remove.pending || permanentlyDelete.pending;
  const activeCall = mode === "trash" ? permanentlyDelete : remove;

  function setRowSelected(id: string, checked: boolean | "indeterminate"): void {
    if (pending || (mode === "trash" && blockers[id] !== undefined)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (checked === true && next.size < BULK_REMOVE_LIMIT) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setVisibleSelected(checked: boolean | "indeterminate"): void {
    if (pending) return;
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
    <div className="flex flex-col gap-4" aria-busy={pending || undefined}>
      <div className="sticky top-0 z-10 grid gap-3 rounded-lg border border-line bg-surface/95 p-3 shadow-panel backdrop-blur lg:grid-cols-[minmax(12rem,20rem)_minmax(12rem,1fr)_auto] lg:items-center">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={pending}
          placeholder="Filter equipment"
          aria-label="Filter equipment"
          icon={<Search />}
          className="w-full"
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <Checkbox
            checked={
              everyVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
            }
            onCheckedChange={setVisibleSelected}
            disabled={pending || visibleRows.length === 0}
            label={normalizedQuery === "" ? "Select all" : "Select all filtered"}
          />
          <span className="min-w-48 flex-1 text-xs leading-5 text-ink-3">
            {filteredGroups.reduce((count, group) => count + group.rows.length, 0)} shown · {selectedRows.length} selected · up to {BULK_REMOVE_LIMIT.toLocaleString()} per removal
          </span>
        </div>
        <Button
          variant="danger"
          icon={<Trash2 aria-hidden="true" />}
          disabled={selectedRows.length === 0 || pending}
          onClick={() => setConfirmOpen(true)}
        >
          {mode === "trash" ? "Delete permanently" : "Remove selected"}
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
                      disabled={pending || blockers[row.id] !== undefined}
                      ariaLabel={`Select ${row.name}`}
                    />
                  </div>
                  <Link
                    href={`/equipment/${row.id}`}
                    aria-disabled={pending || undefined}
                    tabIndex={pending ? -1 : undefined}
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-3 transition-colors duration-100",
                      "hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4",
                      "outline-none focus-visible:bg-surface-2 focus-visible:outline-2",
                      "focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      pending && "pointer-events-none opacity-60",
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
                    {blockers[row.id] === undefined ? null : (
                      <span className="text-xs text-ink-3">Kept: {blockers[row.id]}</span>
                    )}

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
        {mode === "trash"
          ? `${total} out-of-service record(s). Records with history or external references are kept and explain why.`
          : `${total} unit(s) in service or planned. A battery shown as “unknown” means no reading has arrived — never that the battery is empty. A link marked “Renamed in HA” still works: the binding is to the registry id, and only the label we cached is out of date.`}
      </p>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open);
        }}
        hideClose
        title={
          mode === "trash"
            ? `Permanently delete ${selectedRows.length} equipment record(s)?`
            : `Remove ${selectedRows.length} equipment unit(s)?`
        }
        description={
          mode === "trash"
            ? "This cannot be undone. Only unused out-of-service records without history or external references can be deleted."
            : "They leave the active equipment list. Their service history and old Home Assistant links stay in the record."
        }
        footer={
          <>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              disabled={selectedRows.length === 0}
              onClick={() => {
                const assetIds = selectedRows.map((row) => row.id);
                if (mode === "trash") {
                  permanentlyDelete.run({
                    assetIds,
                    idempotencyKey: permanentlyDelete.idempotencyKey,
                  });
                } else {
                  remove.run({ assetIds, idempotencyKey: remove.idempotencyKey });
                }
              }}
            >
              {mode === "trash" ? "Delete permanently" : `Remove ${selectedRows.length}`}
            </Button>
          </>
        }
      >
        <p>
          {mode === "trash"
            ? "Its Home Assistant links, placements, consumables and system memberships will also be deleted. Any record with service history or another dependency is locked outside this selection."
            : "Removed equipment can be imported from Home Assistant again later. Importing creates a current equipment record; it does not erase this one."}
        </p>
        <ul className="mt-3 max-h-56 list-disc overflow-y-auto pl-5 text-ink">
          {selectedRows.map((row) => (
            <li key={row.id}>{row.name}</li>
          ))}
        </ul>
        {activeCall.error === null ? null : (
          <p role="alert" className="mt-3 font-medium text-overdue">{activeCall.error}</p>
        )}
      </Dialog>
    </div>
  );
}
