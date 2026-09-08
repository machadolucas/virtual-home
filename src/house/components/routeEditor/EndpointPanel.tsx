"use client";
/**
 * Recording the fixed things a run starts and ends at: a duct inlet in a room, a shutoff behind
 * the washing machine, the water meter, a patch port.
 *
 * Nothing in the workspace could create one before this, which is why an air-duct inlet — the
 * case that started this — could not be recorded at all.
 *
 * The third field is the one that matters most and is the least obvious: **equipment**. A
 * maintenance plan targets an `asset_id`, and `infra_endpoint.asset_id` is the only bridge between
 * a place in the house and something a plan can be written against. So the form offers to create
 * (or link) a unit right here, and says plainly what that buys: "clean the vents" becomes
 * schedulable. No maintenance schema is involved — the plan is written on the equipment the normal
 * way, against a unit that now exists.
 *
 * An endpoint may legitimately have no coordinates ("the panel in the utility room"), so "room
 * only" is a first-class choice rather than a degraded one.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { InfraEndpointKind } from "@/db/schema/infrastructure";
import {
  ASSET_CATEGORY_LABEL,
  ENDPOINT_KIND_HELP,
  ENDPOINT_KIND_LABEL,
  ENDPOINT_KIND_ORDER,
  ENDPOINT_KIND_SHORT,
} from "@/features/projects/infraEndpoint";
import { ASSET_CATEGORIES, type EndpointDto, type EndpointWrite } from "@/features/projects/wire";
import type { AssetCategory } from "@/db/schema/assets";
import type { Vec3 } from "@/house/model/types";
import { useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { defaultPositionIn } from "./startRouteDraft";
import { searchEquipment, useEndpoints, type EquipmentHit } from "./useEndpoints";

/** How the endpoint is placed. "Room only" is a real answer, not a missing one. */
type Placing = "point" | "room";
/** What the endpoint is attached to, equipment-wise. */
type Attach = "none" | "existing" | "new";

const INPUT = "min-h-8 rounded-md border border-line px-2 text-xs";
const SELECT = "min-h-8 rounded-md border border-line px-1 text-xs";
const BUTTON =
  "min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-50";

export function EndpointPanel() {
  const { index, activeFloorId, selection } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      activeFloorId: s.activeFloorId,
      selection: s.selection,
    })),
  );
  const catalog = useEndpoints();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<InfraEndpointKind>("terminal");
  const [placing, setPlacing] = useState<Placing>("point");
  /**
   * The typed position, keyed by the place it was seeded from. Derived during render rather than
   * written from an effect (the pattern `RouteFields` uses): selecting a different room while the
   * form is open *is* how you say where the vent goes, so the seed has to follow the selection —
   * and typed digits have to survive every other re-render.
   */
  const [heldXyz, setHeldXyz] = useState<{ key: string; xyz: [string, string, string] } | null>(
    null,
  );
  const [attach, setAttach] = useState<Attach>("none");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetHits, setAssetHits] = useState<{ hits: EquipmentHit[]; hasMore: boolean } | null>(
    null,
  );
  const [linkedAsset, setLinkedAsset] = useState<EquipmentHit | null>(null);
  const [newAssetName, setNewAssetName] = useState("");
  const [newAssetCategory, setNewAssetCategory] = useState<AssetCategory>("hvac");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<EndpointDto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const floorId = activeFloorId ?? index?.floorOrder[0] ?? null;
  const selectedRoomId = selection?.kind === "room" ? selection.id : null;
  const roomName = selectedRoomId ? (index?.rooms.get(selectedRoomId)?.name ?? selectedRoomId) : null;

  /**
   * Type-ahead for the existing-unit picker: one request per settled query, and the in-flight one
   * is aborted so a slow answer cannot overwrite a newer list. The list is cleared in the input's
   * own handler, not here, so this effect never writes state synchronously.
   */
  useEffect(() => {
    const query = assetQuery.trim();
    if (attach !== "existing" || query.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchEquipment(query, controller.signal)
        .then(setAssetHits)
        .catch(() => {
          // An aborted or failed lookup leaves the list as it was; the picker is optional.
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [attach, assetQuery]);

  if (!index) return null;

  const seedKey = `${floorId ?? ""}|${selectedRoomId ?? ""}`;
  const xyz: [string, string, string] =
    heldXyz?.key === seedKey
      ? heldXyz.xyz
      : (() => {
          if (!floorId) return ["", "", ""];
          const p = defaultPositionIn(index, floorId, selectedRoomId);
          return [p[0].toFixed(2), p[1].toFixed(2), p[2].toFixed(2)];
        })();
  const setXyz = (next: [string, string, string]): void =>
    setHeldXyz({ key: seedKey, xyz: next });

  const reset = (): void => {
    setName("");
    setKind("terminal");
    setPlacing("point");
    setAttach("none");
    setHeldXyz(null);
    setAssetQuery("");
    setAssetHits(null);
    setLinkedAsset(null);
    setNewAssetName("");
    setFormError(null);
  };

  const position = (): Vec3 | null => {
    const values = xyz.map((v) => Number(v));
    if (values.some((v) => !Number.isFinite(v))) return null;
    return [values[0] as number, values[1] as number, values[2] as number];
  };

  const submit = async (): Promise<void> => {
    setFormError(null);
    setSaved(null);
    if (name.trim() === "") {
      setFormError("Give it a name — “Kitchen extract vent” is what makes it findable later.");
      return;
    }
    const write: EndpointWrite = {
      name: name.trim(),
      kind,
      // A room-only endpoint carries the model node instead of a coordinate, which is exactly
      // what the API asks for: a place, in whichever of the two forms is honest.
      modelNodeId: placing === "room" ? selectedRoomId : null,
      position: placing === "point" ? position() : null,
    };
    if (placing === "point" && write.position === null) {
      setFormError("The position needs three numbers in metres.");
      return;
    }
    if (placing === "room" && !selectedRoomId) {
      setFormError("Select a room in the tree or the 3D view first.");
      return;
    }
    if (attach === "existing") {
      if (!linkedAsset) {
        setFormError("Pick the unit to link, or choose “no equipment”.");
        return;
      }
      write.assetId = linkedAsset.assetId;
    }
    if (attach === "new") {
      if (newAssetName.trim() === "") {
        setFormError("Name the equipment, or choose “no equipment”.");
        return;
      }
      write.newAsset = { name: newAssetName.trim(), category: newAssetCategory };
    }

    setSaving(true);
    const stored = await catalog.save(write);
    setSaving(false);
    if (stored) {
      setSaved(stored);
      reset();
      setOpen(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Inlets, outlets and shutoffs
        </h3>
        <button type="button" className={BUTTON} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "Add endpoint"}
        </button>
      </header>

      {catalog.endpoints.length === 0 ? (
        <p className="text-[11px] text-ink-3">
          {catalog.loading
            ? "Loading…"
            : "None recorded. A duct inlet, a shutoff valve or a meter recorded here is what a route can then run to."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {catalog.endpoints.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0">
                <span className="text-ink">{e.name}</span>{" "}
                <span className="text-ink-3">
                  · {ENDPOINT_KIND_SHORT[e.kind]}
                  {e.assetId ? " · equipment linked" : ""}
                  {e.position === null ? " · room only" : ""}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                {e.assetId ? (
                  <Link
                    href={`/equipment/${e.assetId}`}
                    className="text-[11px] text-ink-2 underline"
                  >
                    Open unit
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={() => void catalog.remove(e.id)}
                  className="text-[11px] text-ink-2 underline"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {saved ? (
        <p role="status" className="rounded-md border border-ok/45 bg-ok-soft p-2 text-[11px] text-ink">
          Saved “{saved.name}”.
          {saved.assetId ? (
            <>
              {" "}
              Its equipment is{" "}
              <Link href={`/equipment/${saved.assetId}`} className="underline">
                on the equipment page
              </Link>
              , and a plan written against it from{" "}
              <Link href="/plans/new" className="underline">
                new plan
              </Link>{" "}
              is what turns “clean the vents” into a task that arrives on its own.
            </>
          ) : null}
        </p>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-2">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kitchen extract vent"
              maxLength={200}
              className={INPUT}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-2">What it is</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as InfraEndpointKind)}
              className={SELECT}
            >
              {ENDPOINT_KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {ENDPOINT_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-ink-2">{ENDPOINT_KIND_HELP[kind]}</span>
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-ink-2">Where it is</legend>
            <select
              value={placing}
              onChange={(e) => setPlacing(e.target.value as Placing)}
              className={SELECT}
            >
              <option value="point">At a point (metres)</option>
              <option value="room">In a room, without a point</option>
            </select>
            {placing === "point" ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {(["x", "y", "z"] as const).map((axis, i) => (
                    <label key={axis} className="flex flex-col gap-1 text-[11px]">
                      <span className="text-ink-3">{axis} (m)</span>
                      <input
                        value={xyz[i]}
                        onChange={(e) => {
                          const next: [string, string, string] = [...xyz];
                          next[i] = e.target.value;
                          setXyz(next);
                        }}
                        inputMode="decimal"
                        className={INPUT}
                      />
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-ink-3">
                  Seeded from {roomName ? `the middle of ${roomName}` : "the middle of this floor"}{" "}
                  at working height. Physical site metres, never a value read from an exploded view.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-ink-3">
                {roomName
                  ? `Recorded as “somewhere in ${roomName}”, which is honest when nobody has measured it.`
                  : "Select a room in the tree or the 3D view — that room is the place."}
              </p>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-ink-2">Equipment</legend>
            <select
              value={attach}
              onChange={(e) => setAttach(e.target.value as Attach)}
              className={SELECT}
            >
              <option value="none">No equipment</option>
              <option value="new">Create a unit for it</option>
              <option value="existing">Link a unit that already exists</option>
            </select>
            <p className="text-[11px] text-ink-2">
              Maintenance is scheduled against equipment, not against a place. Give this endpoint a
              unit and “clean the vents” can be a plan with a due date; leave it without one and the
              endpoint is a record of where something is, nothing more.
            </p>

            {attach === "new" ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px]">
                  <span className="text-ink-3">Unit name</span>
                  <input
                    value={newAssetName}
                    onChange={(e) => setNewAssetName(e.target.value)}
                    placeholder={name.trim() || "Kitchen extract vent"}
                    maxLength={200}
                    className={INPUT}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px]">
                  <span className="text-ink-3">Category</span>
                  <select
                    value={newAssetCategory}
                    onChange={(e) => setNewAssetCategory(e.target.value as AssetCategory)}
                    className={SELECT}
                  >
                    {ASSET_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {ASSET_CATEGORY_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {attach === "existing" ? (
              <div className="flex flex-col gap-1">
                <input
                  value={assetQuery}
                  onChange={(e) => {
                    setAssetQuery(e.target.value);
                    setLinkedAsset(null);
                  }}
                  placeholder="Search equipment by name or model"
                  className={INPUT}
                  aria-label="Search equipment"
                />
                {linkedAsset ? (
                  <p className="text-[11px] text-ink-2">
                    Linking <strong>{linkedAsset.label}</strong>.
                  </p>
                ) : assetHits ? (
                  <>
                    <ul className="flex flex-col gap-1">
                      {assetHits.hits.map((hit) => (
                        <li key={hit.assetId}>
                          <button
                            type="button"
                            onClick={() => setLinkedAsset(hit)}
                            className="text-left text-[11px] text-ink-2 underline"
                          >
                            {hit.label}
                            {hit.secondary ? ` — ${hit.secondary}` : ""}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {assetHits.hits.length === 0 ? (
                      <p className="text-[11px] text-ink-3">Nothing matched.</p>
                    ) : null}
                    {assetHits.hasMore ? (
                      <p className="text-[11px] text-ink-3">
                        More matched than are shown — narrow the search.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-[11px] text-ink-3">Type at least two characters.</p>
                )}
              </div>
            ) : null}
          </fieldset>

          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={() => void submit()} className={BUTTON}>
              {saving ? "Saving…" : "Save endpoint"}
            </button>
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className={BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {formError ? (
        <p role="alert" className="text-[11px] text-overdue">
          {formError}
        </p>
      ) : null}
      {catalog.error ? (
        <p role="alert" className="text-[11px] text-overdue">
          {catalog.error}
        </p>
      ) : null}
    </section>
  );
}
