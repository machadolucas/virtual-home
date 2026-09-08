"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { Badge, Button, Select } from "@/ui";
import {
  BUCKET_BLURB,
  BUCKET_LABEL,
  groupMappings,
  matchReasonText,
  type MappingRow,
} from "@/features/settings/mapping";
import { useAction } from "@/features/settings/actionClient";
import {
  decideLocationMapping,
  refreshMappingSuggestions,
} from "@/server/actions/ha/mappings";

export interface LocationChoice {
  value: string;
  label: string;
  hint?: string;
}

/**
 * HA area/floor -> app location, decided by a person.
 *
 * A confirmed mapping decides where equipment imported from that area lands and how the 3D view
 * groups rooms, so nothing here is automatic (§7.3). A rejection is a real decision too: it is
 * what stops the name matcher proposing the same pairing on every sync.
 */
export function MappingsTable({
  rows,
  locations,
}: {
  rows: readonly MappingRow[];
  locations: readonly LocationChoice[];
}) {
  const groups = groupMappings(rows);

  if (rows.length === 0) {
    return (
      <p className="max-w-prose text-sm leading-6 text-ink-2">
        The registry cache holds no Home Assistant areas or floors, so there is nothing to map yet.
        That usually means the worker has not synced — the connection block above says whether it
        is running.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <RefreshButton />
      {groups.map((group) => (
        <div key={group.bucket} className="flex flex-col gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              {BUCKET_LABEL[group.bucket]}
              <Badge tone="neutral" size="sm">
                {group.rows.length}
              </Badge>
            </h3>
            <p className="max-w-prose text-xs leading-5 text-ink-3">
              {BUCKET_BLURB[group.bucket]}
            </p>
          </div>
          <ul className="flex list-none flex-col divide-y divide-line rounded-md border border-line">
            {group.rows.map((row) => (
              <MappingRowView key={`${row.haKind}:${row.haId}`} row={row} locations={locations} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RefreshButton() {
  const router = useRouter();
  const call = useAction(refreshMappingSuggestions, {
    successTitle: "Suggestions refreshed",
    successDescription: (data) =>
      data.added > 0
        ? `${data.added} new suggestion(s) from exact name matches.`
        : data.locationCount === 0
          ? // Not "no matches were found" — with no rooms recorded, the matcher has nothing to
            // match against and never compares a name at all.
            "There are no rooms in this app yet, so there was nothing to match Home Assistant's areas against. Add rooms first."
          : "No new exact name matches were found.",
    onSuccess: () => router.refresh(),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        loading={call.pending}
        icon={<RefreshCw aria-hidden="true" />}
        onClick={() => call.run({})}
      >
        Look for name matches
      </Button>
      <span className="text-xs text-ink-3">
        Only exact matches, and only for pairings nobody has decided about — it cannot overwrite a
        confirmation or resurrect a rejection.
      </span>
      {call.error === null ? null : (
        <p role="alert" className="w-full text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}
    </div>
  );
}

function MappingRowView({
  row,
  locations,
}: {
  row: MappingRow;
  locations: readonly LocationChoice[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(row.locationId ?? "");
  const call = useAction(decideLocationMapping, {
    successTitle: "Mapping updated",
    onSuccess: () => router.refresh(),
  });

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral" size="sm">
          {row.haKind === "floor" ? "HA floor" : "HA area"}
        </Badge>
        <span className="text-sm font-semibold text-ink">{row.haName}</span>
        {row.haFloorName === null ? null : (
          <span className="text-xs text-ink-3">on {row.haFloorName}</span>
        )}
        {row.deviceCount === 0 ? (
          <span className="text-xs text-ink-3">no devices</span>
        ) : (
          <span className="vh-tnum text-xs text-ink-2">{row.deviceCount} device(s)</span>
        )}
        {row.locationName === null ? null : (
          <span className="text-xs text-ink-2">
            → <span className="font-medium text-ink">{row.locationName}</span>
          </span>
        )}
      </div>

      <p className="text-xs leading-5 text-ink-3">{matchReasonText(row)}</p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-52 flex-1 flex-col gap-1">
          <span className="sr-only">Location for {row.haName}</span>
          <Select
            ariaLabel={`Location for ${row.haName}`}
            value={choice}
            onValueChange={setChoice}
            placeholder="Choose a location…"
            options={locations}
            selectSize="sm"
          />
        </label>
        {/* One trio of these per HA area or floor, so the accessible name has to carry the row. */}
        <Button
          size="sm"
          variant="primary"
          loading={call.pending}
          disabled={choice === ""}
          icon={<Check aria-hidden="true" />}
          aria-label={`Confirm the mapping for ${row.haName}`}
          onClick={() =>
            call.run({
              haKind: row.haKind,
              haId: row.haId,
              locationId: choice,
              decision: "confirm",
            })
          }
        >
          Confirm
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={call.pending}
          disabled={choice === "" && row.locationId === null}
          icon={<X aria-hidden="true" />}
          aria-label={`Reject the mapping for ${row.haName}`}
          onClick={() =>
            call.run({
              haKind: row.haKind,
              haId: row.haId,
              locationId: choice === "" ? row.locationId : choice,
              decision: "reject",
            })
          }
        >
          Reject
        </Button>
        {row.id === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            loading={call.pending}
            aria-label={`Start over on the mapping for ${row.haName}`}
            onClick={() =>
              call.run({ haKind: row.haKind, haId: row.haId, decision: "clear" })
            }
          >
            Start over
          </Button>
        )}
      </div>

      {call.error === null ? null : (
        <p role="alert" className="text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}
    </li>
  );
}
