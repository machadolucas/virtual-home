"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Cpu, Search, X } from "lucide-react";
import { ASSET_CATEGORIES, HA_LINK_ROLES, type AssetCategory, type HaLinkRole } from "@/db/schema";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Input,
  RadioGroup,
  Select,
  Switch,
} from "@/ui";
import { CATEGORY_LABEL, HA_LINK_ROLE_HELP, HA_LINK_ROLE_LABEL } from "@/features/assets/labels";
import { useAction } from "@/features/settings/actionClient";
import { importHaDevice, importHaDevices } from "@/server/actions/ha/import";

/**
 * What to say about an entity Home Assistant is not providing. `live` and "not measured yet" say
 * nothing at all — a note on every healthy row would be noise, and claiming staleness we have not
 * measured would be worse.
 */
const LIVENESS_NOTE: Record<string, string | null> = {
  live: null,
  unmeasured: null,
  restored: "restored — Home Assistant lists it but no integration provides it",
  unavailable: "unavailable right now",
  unknown: "no value (unknown)",
  no_state: "no state object at all",
};

/**
 * Codes `importHaDevices` can refuse with, as sentences. An unmapped code is still shown verbatim
 * rather than replaced with "something went wrong": an unfamiliar code is a better clue than none.
 */
const BULK_ERROR: Record<string, string> = {
  unauthorized: "Your session expired. Reload the page and sign in again.",
  invalid_request: "The server did not accept that selection. Reload the page and try again.",
  internal: "The server could not complete the import. Nothing in the failed batch was created.",
  unknown_category: "That equipment category is not one this app knows.",
  conflict: "Somebody else changed this at the same time. Reload and try again.",
};

const NO_LOCATION = "__none";
const NO_ROLE = "__skip";

export interface BrowserDevice {
  deviceId: string;
  name: string | null;
  nameByUser: string | null;
  manufacturer: string | null;
  model: string | null;
  areaName: string | null;
  entryType: string | null;
  entityCount: number;
  visibleEntityCount: number;
  /** Of the visible entities, how many HA is actually providing right now. */
  liveEntityCount: number;
  /** Visible entities that are restored, unavailable, unknown or stateless. */
  deadEntityCount: number;
  /** No snapshot has measured liveness yet, so nothing is claimed about it. */
  livenessUnmeasured: boolean;
  linkedAssetId: string | null;
  linkedAssetName: string | null;
  suggestedLocationId: string | null;
  suggestedLocationName: string | null;
  suggestedLocationSource: "confirmed" | "suggested" | null;
}

export interface BrowserFloor {
  floorId: string | null;
  floorName: string;
  areas: { areaId: string | null; areaName: string; devices: BrowserDevice[] }[];
}

export interface BrowserEntity {
  registryId: string;
  entityId: string;
  domain: string;
  name: string | null;
  originalName: string | null;
  deviceClass: string | null;
  unitOfMeasurement: string | null;
  entityCategory: string | null;
  state: string | null;
  liveness: "live" | "restored" | "unavailable" | "unknown" | "no_state" | null;
  liveState: string | null;
  disabledBy: string | null;
  hiddenBy: string | null;
  linkedAssetName: string | null;
}

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Browse the cached Home Assistant registry and turn a device into equipment.
 *
 * Everything shown here comes from the **cache**, not from Home Assistant: the web process has no
 * socket (§7.1). So this page works while HA is down, and what it shows is exactly as fresh as the
 * last sync — which the connection block above states rather than hides.
 *
 * Diagnostic entities are included because useful readings such as battery level commonly use that
 * category. Disabled or hidden entities remain out by default; the toggle says how many devices
 * that hides.
 */
export function RegistryBrowser({
  groups,
  deviceCount,
  hiddenDeviceCount,
  deadDeviceCount,
  livenessUnmeasured,
  cacheEmpty,
  includeHidden,
  showDead,
  query,
  locations,
  assets,
  entitiesByDevice,
}: {
  groups: readonly BrowserFloor[];
  deviceCount: number;
  hiddenDeviceCount: number;
  deadDeviceCount: number;
  /** No state snapshot has measured liveness yet, so nothing may be claimed about it. */
  livenessUnmeasured: boolean;
  cacheEmpty: boolean;
  includeHidden: boolean;
  showDead: boolean;
  query: string;
  locations: readonly Choice[];
  assets: readonly Choice[];
  /** Entities per device, pre-loaded for the devices on this page. */
  entitiesByDevice: Record<string, BrowserEntity[]>;
}) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkRoles, setBulkRoles] = useState<Record<string, Record<string, string>>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [hideImported, setHideImported] = useState(false);
  const [draftQuery, setDraftQuery] = useState(query);
  /**
   * The result of the last bulk import, held here rather than in the bar.
   *
   * Finishing a run clears the selection, which unmounts the bar — so a summary owned by the bar
   * was destroyed in the same tick it was set, and every run reported nothing whatever happened.
   */
  const [lastImport, setLastImport] = useState<BulkOutcome | null>(null);

  /**
   * The filter values as of *now*, read at the moment the debounced push fires.
   *
   * `push` used to close over the props, so a search typed and then a toggle flipped within the
   * debounce window pushed the toggle's previous value straight back.
   */
  const latest = useRef({ query, includeHidden, showDead });
  useEffect(() => {
    latest.current = { query, includeHidden, showDead };
  }, [query, includeHidden, showDead]);

  /** The `q` this component last put in the URL, so its own push does not look like navigation. */
  const pushedQuery = useRef(query);

  // Follow the URL when it changes for a reason that is not this box — back/forward, or a link
  // into a filtered view. The input is controlled rather than remounted with `key={query}`:
  // remounting on our own debounced push stole the caret 250 ms after every pause in typing.
  useEffect(() => {
    if (query !== pushedQuery.current) {
      pushedQuery.current = query;
      setDraftQuery(query);
    }
  }, [query]);

  // A pending push after this component is gone yanks the user back to a page they have left.
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const toggleSelected = useCallback((deviceId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(deviceId);
      else next.delete(deviceId);
      return next;
    });
    if (checked) {
      setBulkRoles((current) =>
        current[deviceId] === undefined
          ? { ...current, [deviceId]: emptyRoles(entitiesByDevice[deviceId] ?? []) }
          : current,
      );
    }
  }, [entitiesByDevice]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setBulkRoles({});
  }, []);

  const selectedDevices = [...selected].map((deviceId) => ({
    deviceId,
    entities: Object.entries(bulkRoles[deviceId] ?? {}).flatMap(([registryId, role]) =>
      role === NO_ROLE ? [] : [{ registryId, role: role as HaLinkRole }],
    ),
  }));

  const importedDeviceCount = useMemo(
    () =>
      groups.reduce(
        (count, floor) =>
          count +
          floor.areas.reduce(
            (areaCount, area) =>
              areaCount + area.devices.filter((device) => device.linkedAssetId !== null).length,
            0,
          ),
        0,
      ),
    [groups],
  );
  const visibleGroups = useMemo(
    () =>
      hideImported
        ? groups.flatMap((floor) => {
            const areas = floor.areas.flatMap((area) => {
              const devices = area.devices.filter((device) => device.linkedAssetId === null);
              return devices.length === 0 ? [] : [{ ...area, devices }];
            });
            return areas.length === 0 ? [] : [{ ...floor, areas }];
          })
        : groups,
    [groups, hideImported],
  );
  const visibleDeviceCount = useMemo(
    () =>
      visibleGroups.reduce(
        (count, floor) =>
          count + floor.areas.reduce((areaCount, area) => areaCount + area.devices.length, 0),
        0,
      ),
    [visibleGroups],
  );

  const push = useCallback(
    (next: { q?: string; hidden?: boolean; dead?: boolean }) => {
      const current = latest.current;
      const params = new URLSearchParams();
      const q = next.q === undefined ? current.query : next.q;
      const hidden = next.hidden === undefined ? current.includeHidden : next.hidden;
      const dead = next.dead === undefined ? current.showDead : next.dead;
      if (q !== "") params.set("q", q);
      if (hidden) params.set("hidden", "1");
      if (dead) params.set("dead", "1");
      pushedQuery.current = q;
      const search = params.toString();
      router.replace(
        search === "" ? "/settings/home-assistant" : `/settings/home-assistant?${search}`,
        { scroll: false },
      );
    },
    [router],
  );

  const onType = useCallback(
    (value: string) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => push({ q: value }), 250);
    },
    [push],
  );

  if (cacheEmpty) {
    return (
      <p className="max-w-prose text-sm leading-6 text-ink-2">
        The registry cache is empty. The worker owns the connection to Home Assistant and fills this
        in on start, on every reconnect and hourly as a safety net — so an empty cache means the
        worker has not run, not that your instance has no devices.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 sm:w-72">
          <span className="sr-only">Search devices</span>
          <Input
            type="search"
            disabled={bulkBusy}
            value={draftQuery}
            onChange={(event) => {
              setDraftQuery(event.target.value);
              onType(event.target.value);
            }}
            placeholder="Device, manufacturer, model, area…"
            icon={<Search aria-hidden="true" />}
            trailing={
              draftQuery === "" ? undefined : (
                <IconButton
                  label="Clear search"
                  variant="ghost"
                  size="sm"
                  disabled={bulkBusy}
                  icon={<X aria-hidden="true" />}
                  onClick={() => {
                    if (timer.current !== null) clearTimeout(timer.current);
                    setDraftQuery("");
                    push({ q: "" });
                  }}
                />
              )
            }
          />
        </label>
        <div className="flex flex-col gap-3">
          <Switch
            checked={hideImported}
            disabled={bulkBusy}
            onCheckedChange={setHideImported}
            label="Hide already imported"
            hint={
              importedDeviceCount === 0
                ? "No devices in these results are already imported."
                : `${importedDeviceCount} already imported device(s) in these results.`
            }
          />
          <Switch
            checked={includeHidden}
            disabled={bulkBusy}
            onCheckedChange={(checked) => push({ hidden: checked })}
            label="Show disabled and hidden things"
            hint={
              hiddenDeviceCount === 0
                ? "Nothing is being hidden right now."
                : `${hiddenDeviceCount} device(s) are hidden because the device, or everything it exposes, is disabled or hidden in Home Assistant.`
            }
          />
          <Switch
            checked={showDead}
            disabled={bulkBusy}
            onCheckedChange={(checked) => push({ dead: checked })}
            label="Show things Home Assistant is not providing"
            hint={
              deadDeviceCount > 0
                ? `${deadDeviceCount} device(s) hidden because nothing they expose is live — a restored entity is one Home Assistant still lists but no integration provides. Clean those up in Home Assistant, or turn this on if something here is only temporarily offline.`
                : livenessUnmeasured
                  ? // Nothing has been hidden, but nothing has been *checked* either: after a
                    // registry-only sync every `live_at_ms` is null, and "everything is live" would
                    // be a claim about a measurement that has not happened (rule 8).
                    "Liveness has not been measured yet, so nothing has been hidden on those grounds — the worker records it on its first state snapshot."
                  : "Every device listed has at least one live entity."
            }
          />
        </div>
      </div>

      {selected.size > 0 ? (
        <BulkImportBar
          devices={selectedDevices}
          onStarted={() => setLastImport(null)}
          busy={bulkBusy}
          onBusyChange={(busy) => {
            setBulkBusy(busy);
            if (busy && timer.current !== null) clearTimeout(timer.current);
          }}
          onFinished={(outcome) => {
            setLastImport(outcome);
            clearSelection();
            router.refresh();
          }}
          onClear={clearSelection}
        />
      ) : null}

      {lastImport === null ? null : <BulkImportOutcome outcome={lastImport} />}

      {visibleDeviceCount === 0 ? (
        <p className="text-sm text-ink-3">
          {deviceCount > 0 && hideImported
            ? "Every matching device is already imported. Turn off Hide already imported to see them."
            : "No device matches. Clear the search, or turn on disabled and hidden things."}
        </p>
      ) : (
        visibleGroups.map((floor) => (
          <div key={floor.floorId ?? "__none"} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-3">
              {floor.floorName}
            </h3>
            {floor.areas.map((area) => (
              <div key={area.areaId ?? "__none"} className="flex flex-col gap-1.5">
                <h4 className="text-sm font-medium text-ink-2">{area.areaName}</h4>
                <ul className="flex list-none flex-col divide-y divide-line rounded-md border border-line">
                  {area.devices.map((device) => (
                    <li
                      key={device.deviceId}
                      className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-2.5"
                    >
                      <span className="flex w-11 shrink-0 items-center gap-3">
                        {device.linkedAssetId === null ? (
                          <>
                          {/* The name is the label, but repeating it inline would double every
                              row; an external sr-only label keeps the accessible name. */}
                          <label
                            htmlFor={`select-${device.deviceId}`}
                            className="sr-only"
                          >
                            Select {device.nameByUser ?? device.name ?? device.deviceId} for bulk
                            import
                          </label>
                          <Checkbox
                            id={`select-${device.deviceId}`}
                            checked={selected.has(device.deviceId)}
                            disabled={bulkBusy}
                            onCheckedChange={(checked) =>
                              toggleSelected(device.deviceId, checked === true)
                            }
                          />
                          </>
                        ) : (
                          <span className="w-4 shrink-0" />
                        )}
                        <Cpu aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                      </span>
                      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="min-w-0 text-sm font-medium text-ink">
                          {device.nameByUser ?? device.name ?? device.deviceId}
                        </span>
                        {device.entryType === "service" ? (
                          <Badge tone="neutral" size="sm">
                            Software
                          </Badge>
                        ) : null}
                        <span className="min-w-0 text-xs text-ink-3">
                          {[device.manufacturer, device.model].filter(Boolean).join(" ") ||
                            "no manufacturer recorded"}
                        </span>
                        <span className="vh-tnum text-xs text-ink-3">
                          {device.visibleEntityCount} of {device.entityCount} entities
                        </span>
                        {device.livenessUnmeasured ? null : device.liveEntityCount === 0 &&
                          device.deadEntityCount > 0 ? (
                          <Badge tone="overdue" size="sm">
                            Nothing live
                          </Badge>
                        ) : device.deadEntityCount > 0 ? (
                          <Badge tone="stale" size="sm">
                            {device.deadEntityCount} not live
                          </Badge>
                        ) : null}
                        {device.linkedAssetId === null ? null : (
                          <Badge tone="ok" size="sm">
                            Already {device.linkedAssetName}
                          </Badge>
                        )}
                      </span>
                      <span className="shrink-0">
                        <ImportDialog
                          device={device}
                          entities={entitiesByDevice[device.deviceId] ?? []}
                          locations={locations}
                          assets={assets}
                          disabled={bulkBusy}
                        />
                      </span>
                      {device.linkedAssetId === null && selected.has(device.deviceId) ? (
                        <div className="col-span-3 min-w-0 sm:col-span-2 sm:col-start-2">
                          <BulkEntityChoices
                            deviceName={device.nameByUser ?? device.name ?? device.deviceId}
                            entities={entitiesByDevice[device.deviceId] ?? []}
                            roles={bulkRoles[device.deviceId] ?? {}}
                            disabled={bulkBusy}
                            onRoleChange={(registryId, role) =>
                              setBulkRoles((current) => ({
                                ...current,
                                [device.deviceId]: setRole(
                                  current[device.deviceId] ?? {},
                                  registryId,
                                  role,
                                ),
                              }))
                            }
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Bulk import: one category for the batch and explicit entity roles per selected device.
 *
 * With a registry of a few hundred devices the single-device dialog is the wrong tool. Entity
 * choices are made on the selected rows. Nothing is preselected from names or device
 * classes, so the server receives only choices the person actually made.
 *
 * Sent in chunks of 50 (the action's cap) to keep each write transaction short, with progress
 * across chunks and the three outcomes reported separately at the end.
 *
 * Two things this has to get right, both of which it once got wrong:
 *  - **The idempotency key is per run, not per selection.** It used to be the joined device ids
 *    truncated to 200 characters, which is about five of them: a later import of any set sharing
 *    those first five replayed the earlier stored response and reported "Created 8" while writing
 *    nothing at all.
 *  - **Every path ends with a summary.** A refused chunk used to `return` out of the loop, which
 *    threw away the counts from the chunks that had already committed, left the page showing the
 *    pre-import list, and said nothing about how far it got.
 */
export interface BulkOutcome {
  /** Devices in the selection when the run started. */
  total: number;
  /** Devices in chunks the server accepted. Less than `total` means it stopped part-way. */
  attempted: number;
  created: number;
  skipped: number;
  /** The reason it stopped, already turned into a sentence. `null` when it ran to the end. */
  error: string | null;
}

function BulkImportBar({
  devices,
  busy,
  onBusyChange,
  onStarted,
  onFinished,
  onClear,
}: {
  devices: readonly {
    deviceId: string;
    entities: readonly { registryId: string; role: HaLinkRole }[];
  }[];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onStarted: () => void;
  onFinished: (outcome: BulkOutcome) => void;
  onClear: () => void;
}) {
  const CHUNK = 50;
  const [category, setCategory] = useState<AssetCategory>("appliance");
  const [done, setDone] = useState(0);
  const running = useRef(false);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    onBusyChange(true);
    setDone(0);
    onStarted();
    let created = 0;
    let skipped = 0;
    let attempted = 0;
    let error: string | null = null;
    // One key per press of the button, extended per chunk. Random, so two runs over overlapping
    // selections are two runs; stable within the run, so a retried chunk replays rather than
    // creating a second copy of everything it already wrote. The fallback matches
    // `features/settings/actionClient`: `randomUUID` needs a secure context.
    const runId =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      for (let i = 0; i < devices.length; i += CHUNK) {
        const chunk = devices.slice(i, i + CHUNK);
        const result = await importHaDevices({
          devices: chunk,
          category,
          useMappedLocation: true,
          idempotencyKey: `bulk-${runId}-${i / CHUNK}`,
        });
        if (!result.ok) {
          error = BULK_ERROR[result.error] ?? `The server refused the import (${result.error}).`;
          break;
        }
        created += result.data.createdCount;
        skipped += result.data.skipped.length;
        attempted += chunk.length;
        setDone(Math.min(i + chunk.length, devices.length));
      }
    } catch (err) {
      // A rejected promise — the action never returned, so nothing is known about the last chunk.
      // Reported rather than swallowed, and the counts from the chunks that did commit are kept.
      error =
        err instanceof Error
          ? `The import stopped: ${err.message}`
          : "The import stopped before it could finish.";
    } finally {
      running.current = false;
      onBusyChange(false);
      // Always, on every path. The rows this run did create are real whether or not the run
      // finished, so the page has to be refreshed and the outcome stated — leaving the list stale
      // after a partial import is how somebody imports the same set twice.
      onFinished({ total: devices.length, attempted, created, skipped, error });
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-surface-2 p-3">
      <p className="text-sm text-ink">
        <span className="font-medium">{devices.length}</span> selected
      </p>
      <Field label="Category for all of them" className="w-56">
        {({ id, describedBy }) => (
          <Select
            id={id}
            describedBy={describedBy}
            value={category}
            disabled={busy}
            onValueChange={(value) => setCategory(value as AssetCategory)}
            options={ASSET_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABEL[value] }))}
          />
        )}
      </Field>
      <Button onClick={() => void run()} disabled={busy}>
        {busy ? `Importing ${done} of ${devices.length}…` : `Import ${devices.length}`}
      </Button>
      <Button variant="ghost" onClick={onClear} disabled={busy}>
        Clear
      </Button>
      <p className="basis-full text-xs leading-5 text-ink-3">
        Creates one piece of equipment per device, linked to the device row, with the room from a
        <em> confirmed</em> area mapping only. Entity roles chosen on each selected row are imported
        with it; unselected entities are left alone.
      </p>
    </div>
  );
}

function EntityStatusBadges({ entity }: { entity: BrowserEntity }) {
  const state = entity.liveness;
  const label = state === "unavailable" ? "Unavailable" : state === "unknown" ? "Unknown" : state === "restored" ? "Restored" : state === "no_state" ? "No state" : null;
  return <span className="flex flex-wrap gap-1">
    {entity.disabledBy ? <Badge tone="neutral" size="sm">Disabled</Badge> : null}
    {entity.hiddenBy ? <Badge tone="neutral" size="sm">Hidden</Badge> : null}
    {label ? <Badge tone="stale" size="sm">{label}</Badge> : null}
  </span>;
}

function BulkEntityChoices({
  deviceName,
  entities,
  roles,
  disabled,
  onRoleChange,
}: {
  deviceName: string;
  entities: readonly BrowserEntity[];
  roles: Readonly<Record<string, string>>;
  disabled: boolean;
  onRoleChange: (registryId: string, role: string) => void;
}) {
  return (
    <div className="basis-full rounded-sm border border-line bg-surface-2 p-2.5">
      <p className="mb-2 text-xs leading-5 text-ink-2">
        Choose entities for {deviceName}. Primary and battery level are limited to one each; status
        / reading may be used for temperature, humidity, illuminance and other readings.
      </p>
      {entities.length === 0 ? (
        <p className="text-xs text-ink-3">No visible entities are available for this device.</p>
      ) : (
        <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,26rem),1fr))] gap-3">
          {entities.map((entity) => (
            <li key={entity.registryId} className="grid min-w-0 grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ink" title={entity.name ?? entity.originalName ?? entity.deviceClass ?? entity.domain}>{entity.name ?? entity.originalName ?? entity.deviceClass ?? entity.domain}</span>
                <span className="block truncate font-mono text-xs text-ink-3" title={entity.entityId}>{entity.entityId}</span>
                <EntityStatusBadges entity={entity} />
              </span>
              <span className="min-w-0 w-full">
                <Select
                  ariaLabel={`Role for ${entity.entityId}`}
                  selectSize="sm"
                  disabled={disabled}
                  value={roles[entity.registryId] ?? NO_ROLE}
                  onValueChange={(role) => onRoleChange(entity.registryId, role)}
                  options={[
                    { value: NO_ROLE, label: "Do not link" },
                    ...HA_LINK_ROLES.map((role) => ({
                      value: role,
                      label: HA_LINK_ROLE_LABEL[role],
                      hint: HA_LINK_ROLE_HELP[role],
                    })),
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What the last bulk import did, stated after the bar has gone.
 *
 * It reports what was attempted as well as what was created, because "Created 8" out of a
 * selection of fifty is a different sentence from "Created 8" out of eight.
 */
function BulkImportOutcome({ outcome }: { outcome: BulkOutcome }) {
  const complete = outcome.error === null && outcome.attempted === outcome.total;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-3">
      {outcome.error === null ? null : (
        // `text-overdue`, which is a real token — `text-danger` is not defined anywhere in
        // globals.css, so this rendered in inherited ink, indistinguishable from the grey note
        // beside it. The glyph carries the same meaning without relying on the colour.
        <p role="alert" className="flex items-start gap-1.5 text-xs leading-5 text-overdue">
          <span aria-hidden="true">&#9650;</span>
          <span>{outcome.error}</span>
        </p>
      )}
      <p className="text-xs leading-5 text-ink-2">
        {complete
          ? `Created ${outcome.created} of ${outcome.total} selected.`
          : `Stopped after ${outcome.attempted} of ${outcome.total} selected; ${outcome.created} created before it stopped. The rest were not attempted — select them again to retry.`}{" "}
        {outcome.skipped > 0
          ? `Skipped ${outcome.skipped} that were already linked or gone from the registry.`
          : "Nothing skipped."}
      </p>
    </div>
  );
}

function ImportDialog({
  device,
  entities,
  locations,
  assets,
  disabled,
}: {
  device: BrowserDevice;
  entities: readonly BrowserEntity[];
  locations: readonly Choice[];
  assets: readonly Choice[];
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isService = device.entryType === "service";
  const [mode, setMode] = useState<"new" | "existing">(
    device.linkedAssetId === null ? "new" : "existing",
  );
  const [existingAssetId, setExistingAssetId] = useState(device.linkedAssetId ?? "");
  const [name, setName] = useState(device.nameByUser ?? device.name ?? "");
  const [category, setCategory] = useState<AssetCategory>(isService ? "software" : "appliance");
  const [locationId, setLocationId] = useState(
    isService ? NO_LOCATION : (device.suggestedLocationId ?? NO_LOCATION),
  );
  const [linkDevice, setLinkDevice] = useState(true);
  const [roles, setRoles] = useState<Record<string, string>>(() => defaultRoles(entities));

  const call = useAction(importHaDevice, {
    successTitle: "Linked",
    successDescription: (data) =>
      data.created
        ? `Created equipment with ${data.linkCount} Home Assistant link(s).`
        : `Added ${data.linkCount} link(s) to the existing unit.`,
    onSuccess: (data) => {
      setOpen(false);
      router.push(`/equipment/${data.assetId}`);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="lg"
      trigger={
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          iconTrailing={<ChevronRight aria-hidden="true" />}
          // The visible text stays two words; the accessible name names the row, so a list of 483
          // devices is not 483 buttons all called "Import".
          aria-label={`${device.linkedAssetId === null ? "Import" : "Link more to"} ${
            device.nameByUser ?? device.name ?? device.deviceId
          }`}
        >
          {device.linkedAssetId === null ? "Import" : "Link more"}
        </Button>
      }
      title={device.nameByUser ?? device.name ?? "Import device"}
      description="Create a piece of equipment from this device, or attach it to one that already exists. Everything shown comes from the cached registry, so this works while Home Assistant is down."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={
              (mode === "new" && name.trim() === "") ||
              (mode === "existing" && existingAssetId === "")
            }
            onClick={() =>
              call.run({
                deviceId: device.deviceId,
                existingAssetId: mode === "existing" ? existingAssetId : null,
                name: mode === "new" ? name : (device.nameByUser ?? device.name ?? "Device"),
                category,
                manufacturer: device.manufacturer,
                modelName: device.model,
                locationId: locationId === NO_LOCATION ? null : locationId,
                isVirtual: isService,
                linkDevice,
                entities: Object.entries(roles).flatMap(([registryId, role]) =>
                  role === NO_ROLE ? [] : [{ registryId, role: role as HaLinkRole }],
                ),
                idempotencyKey: call.idempotencyKey,
              })
            }
          >
            {mode === "new" ? "Create and link" : "Link it"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {isService ? (
          <p className="rounded-md border border-line bg-surface-2 p-3 text-sm leading-6 text-ink-2">
            Home Assistant marks this as a <span className="font-mono text-xs">service</span> device
            — an integration rather than a thing you can touch. It will be recorded as software,
            with no room, which is exactly right: it is real and it needs maintaining, but it is not
            in the kitchen.
          </p>
        ) : null}

        <RadioGroup
          ariaLabel="What to do with this device"
          value={mode}
          onValueChange={(value) => setMode(value as "new" | "existing")}
          options={[
            { value: "new", label: "Create new equipment from it" },
            {
              value: "existing",
              label: "Link it to equipment I already have",
              hint:
                assets.length === 0
                  ? "No equipment is recorded yet."
                  : "For a device that reports on something you already added by hand.",
              disabled: assets.length === 0,
            },
          ]}
        />

        {mode === "existing" ? (
          <Field label="Which unit" required>
            {({ id }) => (
              <Select
                id={id}
                value={existingAssetId}
                onValueChange={setExistingAssetId}
                placeholder="Choose equipment…"
                options={assets}
              />
            )}
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              required
              className="sm:col-span-2"
              help="Prefilled from Home Assistant. Change it to whatever you actually call the thing."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            <Field label="Category" required>
              {({ id }) => (
                <Select
                  id={id}
                  value={category}
                  onValueChange={(value) => setCategory(value as AssetCategory)}
                  options={ASSET_CATEGORIES.map((entry) => ({
                    value: entry,
                    label: CATEGORY_LABEL[entry],
                  }))}
                />
              )}
            </Field>
            <Field
              label="Location"
              help={
                isService
                  ? "A software unit has no room."
                  : device.suggestedLocationSource === "confirmed"
                    ? `From the confirmed mapping for the “${device.areaName}” area.`
                    : device.suggestedLocationSource === "suggested"
                      ? `Suggested from the “${device.areaName}” area — that mapping is not confirmed yet, so check it.`
                      : "The area has no mapping, so nothing is preselected."
              }
            >
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  describedBy={describedBy}
                  disabled={isService}
                  value={locationId}
                  onValueChange={setLocationId}
                  options={[{ value: NO_LOCATION, label: "No location" }, ...locations]}
                />
              )}
            </Field>
            <div className="sm:col-span-2 text-xs leading-5 text-ink-3">
              No install date is recorded. Home Assistant knows when it first <em>saw</em> the
              device, which is not when it was installed — and inventing that date would be
              fabricating history.
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <Checkbox
            checked={linkDevice}
            onCheckedChange={(checked) => setLinkDevice(checked === true)}
            label="Link the device itself as well as its entities"
            hint="A device-level link survives an entity being replaced, and is what lets a battery be found through the device's canonical battery entity."
          />

          <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
            Which entities, and as what
          </h3>
          {entities.length === 0 ? (
            <p className="text-sm text-ink-3">
              This device exposes nothing worth linking because everything it has is disabled or
              hidden in Home Assistant.
            </p>
          ) : (
            <ul className="flex list-none flex-col divide-y divide-line rounded-md border border-line">
              {entities.map((entity) => (
                <li
                  key={entity.registryId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-xs font-medium text-ink">{entity.name ?? entity.originalName ?? entity.deviceClass ?? entity.domain}</span>
                    <span className="break-all font-mono text-xs text-ink-3">{entity.entityId}</span>
                    <EntityStatusBadges entity={entity} />
                    <span className="text-xs text-ink-3">
                      {[
                        entity.name ?? entity.originalName,
                        entity.deviceClass,
                        entity.state === null
                          ? "no reading cached"
                          : `${entity.state}${entity.unitOfMeasurement === null ? "" : ` ${entity.unitOfMeasurement}`}`,
                        entity.entityCategory,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {LIVENESS_NOTE[entity.liveness ?? "unmeasured"] ? (
                      // `text-stale`, a real token — `text-warning` does not exist, so this note
                      // rendered in the same grey as the metadata line above it. The glyph means
                      // the note still reads as a warning without the colour.
                      <span className="flex items-start gap-1.5 text-xs text-stale">
                        <span aria-hidden="true">&#9888;</span>
                        <span>{LIVENESS_NOTE[entity.liveness ?? "unmeasured"]}</span>
                      </span>
                    ) : null}
                    {entity.linkedAssetName === null ? null : (
                      <span className="text-xs text-ink-3">
                        already linked to {entity.linkedAssetName}
                      </span>
                    )}
                  </span>
                  <span className="w-44 shrink-0">
                    <Select
                      ariaLabel={`Role for ${entity.entityId}`}
                      selectSize="sm"
                      value={roles[entity.registryId] ?? NO_ROLE}
                      onValueChange={(value) =>
                        setRoles((current) => setRole(current, entity.registryId, value))
                      }
                      options={[
                        { value: NO_ROLE, label: "Do not link" },
                        ...HA_LINK_ROLES.map((role) => ({
                          value: role,
                          label: HA_LINK_ROLE_LABEL[role],
                          hint: HA_LINK_ROLE_HELP[role],
                        })),
                      ]}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs leading-5 text-ink-3">
            The role matters: <strong className="font-semibold">battery level</strong> is what the
            low-battery rule watches, and <strong className="font-semibold">primary</strong> is the
            one entity that best represents the unit. Both are limited to one per unit, so the app
            never has to guess which of three sensors it meant.
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

/**
 * Pre-select the obvious roles and nothing else.
 *
 * An unlinked `battery` device class is unambiguous, so it is pre-set. An existing link stays at
 * "do not link" when this dialog is opened through "Link more"; submitting the same entity again
 * would only produce a duplicate-link refusal. Everything else is left unset because a guessed
 * role can quietly point a rule at the wrong sensor.
 */
function defaultRoles(entities: readonly BrowserEntity[]): Record<string, string> {
  const out: Record<string, string> = {};
  let batteryTaken = false;
  for (const entity of entities) {
    if (!batteryTaken && entity.deviceClass === "battery" && entity.domain === "sensor") {
      out[entity.registryId] = entity.linkedAssetName === null ? "battery_level" : NO_ROLE;
      batteryTaken = true;
      continue;
    }
    out[entity.registryId] = NO_ROLE;
  }
  return out;
}

/** Bulk selection starts empty: choosing an entity in a large batch must be a deliberate act. */
function emptyRoles(entities: readonly BrowserEntity[]): Record<string, string> {
  return Object.fromEntries(entities.map((entity) => [entity.registryId, NO_ROLE]));
}

/** Selecting a unique role moves it instead of leaving the form in a state the server must reject. */
function setRole(
  current: Readonly<Record<string, string>>,
  registryId: string,
  role: string,
): Record<string, string> {
  const next = { ...current };
  if (role === "primary" || role === "battery_level") {
    for (const [otherRegistryId, otherRole] of Object.entries(next)) {
      if (otherRegistryId !== registryId && otherRole === role) next[otherRegistryId] = NO_ROLE;
    }
  }
  next[registryId] = role;
  return next;
}
