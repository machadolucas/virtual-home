"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
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
import { importHaDevice } from "@/server/actions/ha/import";

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
 * Diagnostic and config entities, and disabled or hidden ones, are out by default. A modern HA
 * instance has thousands of them (signal strength, update entities, restart buttons) and none of
 * them is a piece of equipment. The toggle says how many are being hidden.
 */
export function RegistryBrowser({
  groups,
  deviceCount,
  hiddenDeviceCount,
  cacheEmpty,
  includeHidden,
  query,
  locations,
  assets,
  entitiesByDevice,
}: {
  groups: readonly BrowserFloor[];
  deviceCount: number;
  hiddenDeviceCount: number;
  cacheEmpty: boolean;
  includeHidden: boolean;
  query: string;
  locations: readonly Choice[];
  assets: readonly Choice[];
  /** Entities per device, pre-loaded for the devices on this page. */
  entitiesByDevice: Record<string, BrowserEntity[]>;
}) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = useCallback(
    (next: { q?: string; hidden?: boolean }) => {
      const params = new URLSearchParams();
      const q = next.q === undefined ? query : next.q;
      const hidden = next.hidden === undefined ? includeHidden : next.hidden;
      if (q !== "") params.set("q", q);
      if (hidden) params.set("hidden", "1");
      const search = params.toString();
      router.replace(
        search === "" ? "/settings/home-assistant" : `/settings/home-assistant?${search}`,
        { scroll: false },
      );
    },
    [query, includeHidden, router],
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
            key={query}
            type="search"
            defaultValue={query}
            onChange={(event) => onType(event.target.value)}
            placeholder="Device, manufacturer, model, area…"
            icon={<Search aria-hidden="true" />}
            trailing={
              query === "" ? undefined : (
                <IconButton
                  label="Clear search"
                  variant="ghost"
                  size="sm"
                  icon={<X aria-hidden="true" />}
                  onClick={() => {
                    if (timer.current !== null) clearTimeout(timer.current);
                    push({ q: "" });
                  }}
                />
              )
            }
          />
        </label>
        <Switch
          checked={includeHidden}
          onCheckedChange={(checked) => push({ hidden: checked })}
          label="Show diagnostic and disabled things"
          hint={
            hiddenDeviceCount === 0
              ? "Nothing is being hidden right now."
              : `${hiddenDeviceCount} device(s) are hidden because everything they expose is diagnostic, config, disabled or hidden.`
          }
        />
      </div>

      {deviceCount === 0 ? (
        <p className="text-sm text-ink-3">
          No device matches. Clear the search, or turn on diagnostic and disabled things.
        </p>
      ) : (
        groups.map((floor) => (
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
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
                    >
                      <Cpu aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                      <span className="text-sm font-medium text-ink">
                        {device.nameByUser ?? device.name ?? device.deviceId}
                      </span>
                      {device.entryType === "service" ? (
                        <Badge tone="neutral" size="sm">
                          Software
                        </Badge>
                      ) : null}
                      <span className="text-xs text-ink-3">
                        {[device.manufacturer, device.model].filter(Boolean).join(" ") ||
                          "no manufacturer recorded"}
                      </span>
                      <span className="vh-tnum text-xs text-ink-3">
                        {device.visibleEntityCount} of {device.entityCount} entities
                      </span>
                      {device.linkedAssetId === null ? null : (
                        <Badge tone="ok" size="sm">
                          Already {device.linkedAssetName}
                        </Badge>
                      )}
                      <span className="ml-auto">
                        <ImportDialog
                          device={device}
                          entities={entitiesByDevice[device.deviceId] ?? []}
                          locations={locations}
                          assets={assets}
                        />
                      </span>
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

function ImportDialog({
  device,
  entities,
  locations,
  assets,
}: {
  device: BrowserDevice;
  entities: readonly BrowserEntity[];
  locations: readonly Choice[];
  assets: readonly Choice[];
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
          iconTrailing={<ChevronRight aria-hidden="true" />}
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
              This device exposes nothing worth linking (everything it has is diagnostic, config,
              disabled or hidden).
            </p>
          ) : (
            <ul className="flex list-none flex-col divide-y divide-line rounded-md border border-line">
              {entities.map((entity) => (
                <li
                  key={entity.registryId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-mono text-xs text-ink">{entity.entityId}</span>
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
                        setRoles((current) => ({ ...current, [entity.registryId]: value }))
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
 * A `battery` device class is unambiguous, so it is pre-set. Everything else is left at "do not
 * link", because a guessed role is worse than an unset one: a rule pointed at the wrong sensor
 * fails quietly, and quietly is the problem.
 */
function defaultRoles(entities: readonly BrowserEntity[]): Record<string, string> {
  const out: Record<string, string> = {};
  let batteryTaken = false;
  for (const entity of entities) {
    if (!batteryTaken && entity.deviceClass === "battery" && entity.domain === "sensor") {
      out[entity.registryId] = "battery_level";
      batteryTaken = true;
      continue;
    }
    out[entity.registryId] = NO_ROLE;
  }
  return out;
}
