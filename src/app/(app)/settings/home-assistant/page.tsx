import type { Metadata } from "next";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, ConnectionPill, Panel, connectionStateOf } from "@/ui";
import { PageHeader } from "@/ui/shell";
import type { IntegrationState } from "@/db/schema";
import { pageContext } from "@/server/queries/settings/household";
import { listLocationOptions } from "@/server/queries/assets/list";
import { listAssetOptions } from "@/server/queries/inventory/detail";
import { listPartOptions } from "@/server/queries/inventory/list";
import {
  browseRegistry,
  listLinkableEntities,
  readDeviceEntities,
} from "@/server/queries/ha/registry";
import { listConditionRules, listLocationMappings } from "@/server/queries/ha/mappings";
import { readIntegrationStatus, workerAlive } from "@/server/ha/status";
import { formatAge, isoOf } from "@/features/settings/format";
import { loadEnv } from "@/env";
import { MappingsTable } from "./MappingsTable";
import { RegistryBrowser, type BrowserEntity } from "./RegistryBrowser";
import { RulesPanel } from "./RulesPanel";

export const metadata: Metadata = { title: "Home Assistant" };

/**
 * `/settings/home-assistant` — the connection, the cached registry, the mappings and the rules.
 *
 * The distinction this page exists to make: a stale heartbeat means **the worker** is down, which
 * is a different message from "Home Assistant is unreachable". Blaming HA for a dead worker is the
 * kind of bug that costs an hour of debugging the wrong box, so the two are reported separately
 * and neither is guessed from the other.
 *
 * The pill in the header comes from `connectionStateOf` in `@/ui/status` — the same function the
 * app shell's pill and the Today banner use, so two pills on one screen cannot disagree.
 */
export default async function HomeAssistantSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSessionPage("/settings/home-assistant");
  const params = await searchParams;
  const query = firstValue(params["q"]) ?? "";
  const includeHidden = firstValue(params["hidden"]) === "1";
  // Dead rows are out by default; `?dead=1` brings them back for the rare "where did my washing
  // machine go" moment.
  const showDead = firstValue(params["dead"]) === "1";

  const { db, household, nowMs } = pageContext();
  const env = loadEnv();
  const status = readIntegrationStatus(db);
  const alive = workerAlive(status, nowMs, env.VH_WORKER_HEARTBEAT_MS);

  const registry = browseRegistry(db, { includeHidden, query, hideDead: !showDead });

  // Entities for the devices actually on screen. Loading them per device on demand would be a
  // round trip per row; loading the whole registry would be thousands of rows for no reason.
  const entitiesByDevice: Record<string, BrowserEntity[]> = {};
  for (const floor of registry.groups) {
    for (const area of floor.areas) {
      for (const device of area.devices) {
        entitiesByDevice[device.deviceId] = readDeviceEntities(db, device.deviceId, {
          includeHidden,
        }).map((entity) => ({
          registryId: entity.registryId,
          entityId: entity.entityId,
          domain: entity.domain,
          name: entity.name,
          originalName: entity.originalName,
          deviceClass: entity.deviceClass,
          unitOfMeasurement: entity.unitOfMeasurement,
          entityCategory: entity.entityCategory,
          state: entity.state,
          liveness: entity.liveness,
          liveState: entity.liveState,
          disabledBy: entity.disabledBy,
          hiddenBy: entity.hiddenBy,
          linkedAssetName: entity.linkedAssetName,
        }));
      }
    }
  }

  const locations = listLocationOptions(db).map((location) => ({
    value: location.id,
    label: location.name,
    hint: location.parentName ?? location.kind,
  }));
  const assets = listAssetOptions(db).map((asset) => ({
    value: asset.id,
    label: asset.name,
    hint: asset.locationName ?? undefined,
  }));

  // Targets for an entity-scoped rule. The same capped list the equipment page links against; the
  // panel says when it was truncated rather than presenting a shortlist as the whole instance.
  const linkable = listLinkableEntities(db, { limit: 400 });
  const ruleEntities = linkable.entities.map((entity) => ({
    value: entity.registryId,
    label: entity.entityId,
    hint:
      [entity.deviceName, entity.areaName, entity.deviceClass].filter(Boolean).join(" · ") ||
      entity.domain,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Home Assistant"
        description="Read entity states, send notifications to phones. Everything is bound by registry id, never by display name, so renaming something in Home Assistant cannot silently break a binding."
        actions={<ConnectionPill state={connectionStateOf(status?.state ?? null, alive)} />}
      />

      <Panel
        title="Connection"
        subtitle="Reported by the worker process. This page never talks to Home Assistant itself."
      >
        {status === null ? (
          <p className="max-w-prose text-sm leading-6 text-ink-2">
            No status has ever been written, which means the worker has not started since this
            database was created. That is not the same as “disconnected” — we have no report either
            way, and the app will not show a working link it cannot justify.
          </p>
        ) : (
          <>
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Detail term="State" value={STATE_LABEL[status.state]}>
                {STATE_HELP[status.state]}
              </Detail>
              <Detail term="Background service" value={alive ? "Running" : "Not running"}>
                {alive
                  ? `Heartbeat ${formatAge(status.heartbeatAtMs, nowMs) ?? "unknown"}, every ${Math.round(env.VH_WORKER_HEARTBEAT_MS / 1000)} s.`
                  : `Its last heartbeat was ${formatAge(status.heartbeatAtMs, nowMs) ?? "never"}. A stale heartbeat means the worker is down — not that Home Assistant is unreachable.`}
              </Detail>
              <Detail term="Home Assistant version" value={status.haVersion ?? "Not reported"} />
              <Detail
                term="Last successful message"
                value={formatAge(status.lastOkAtMs, nowMs) ?? "Never"}
              >
                {isoOf(status.lastOkAtMs) ?? undefined}
              </Detail>
              <Detail term="Reconnects" value={String(status.reconnectCount)}>
                Since the worker last started. A number that keeps climbing means a flaky link.
              </Detail>
              <Detail term="Entities cached" value={String(status.entityCount)}>
                Only the entities something actually references — a link, a canonical battery, or a
                rule. Not the whole instance.
              </Detail>
            </dl>
            {status.lastError === null ? null : (
              <div className="mt-4 border-t border-line pt-4">
                <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                  Last error
                </h3>
                <p className="mt-1 max-w-prose break-words font-mono text-xs leading-5 text-overdue">
                  {status.lastError}
                </p>
                <p className="mt-1 text-xs text-ink-3">
                  Scrubbed of the access token before it was stored, so it is safe to read and to
                  paste into a bug report.
                </p>
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel title="The access token" subtitle="Why there is no field for it here.">
        <p className="max-w-prose text-sm leading-6 text-ink-2">
          The long-lived access token lives in the server environment (
          <code className="font-mono text-xs">HA_TOKEN</code>, read from{" "}
          <code className="font-mono text-xs">$VH_DATA_DIR/secrets/vh.env</code> at mode 0600) and
          is loaded once at start-up. It is never entered in a browser, never rendered, and never
          logged — error messages are scrubbed of it before they are stored.
        </p>
        <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-6 text-ink-2">
          <li>
            In Home Assistant, open your profile, scroll to <em>Long-lived access tokens</em> and
            create one.
          </li>
          <li>
            On the machine running this app, put it in the secrets file as{" "}
            <code className="font-mono text-xs">HA_TOKEN=…</code> alongside{" "}
            <code className="font-mono text-xs">HA_URL=…</code>.
          </li>
          <li>
            Restart the worker. Configuration is validated at start-up, so a bad value fails loudly
            rather than half-working.
          </li>
        </ol>
        <p className="mt-3 text-xs leading-5 text-ink-3">
          Currently configured to reach{" "}
          <code className="font-mono">{env.HA_URL ?? "nothing — HA_URL is unset"}</code>
          {env.HA_URL === undefined
            ? ". Scheduling and history work perfectly well without Home Assistant; only live state and phone notifications need it."
            : "."}
        </p>
      </Panel>

      <Panel
        title="Import & link"
        subtitle="Browse the cached registry by floor and area, then turn a device into equipment."
      >
        <RegistryBrowser
          groups={registry.groups.map((floor) => ({
            floorId: floor.floorId,
            floorName: floor.floorName,
            areas: floor.areas.map((area) => ({
              areaId: area.areaId,
              areaName: area.areaName,
              devices: area.devices.map((device) => ({
                deviceId: device.deviceId,
                name: device.name,
                nameByUser: device.nameByUser,
                manufacturer: device.manufacturer,
                model: device.model,
                areaName: device.areaName,
                entryType: device.entryType,
                entityCount: device.entityCount,
                visibleEntityCount: device.visibleEntityCount,
                liveEntityCount: device.liveEntityCount,
                deadEntityCount: device.deadEntityCount,
                livenessUnmeasured: device.livenessUnmeasured,
                linkedAssetId: device.linkedAssetId,
                linkedAssetName: device.linkedAssetName,
                suggestedLocationId: device.suggestedLocationId,
                suggestedLocationName: device.suggestedLocationName,
                suggestedLocationSource: device.suggestedLocationSource,
              })),
            })),
          }))}
          deviceCount={registry.deviceCount}
          hiddenDeviceCount={registry.hiddenDeviceCount}
          deadDeviceCount={registry.deadDeviceCount}
          livenessUnmeasured={registry.livenessUnmeasured}
          cacheEmpty={registry.cacheEmpty}
          includeHidden={includeHidden}
          showDead={showDead}
          query={query}
          locations={locations}
          assets={assets}
          entitiesByDevice={entitiesByDevice}
        />
      </Panel>

      <Panel
        title="Locations"
        subtitle="Home Assistant's areas and floors, matched to this app's rooms."
      >
        <p className="mb-4 max-w-prose text-sm leading-6 text-ink-2">
          A confirmed mapping does two things: it defaults the room of any equipment imported from
          that area, and it groups the 3D view. Nothing is confirmed automatically — the name
          matcher only ever <em>suggests</em>, because a mapping is a claim about the house.
        </p>
        <MappingsTable rows={listLocationMappings(db)} locations={locations} />
      </Panel>

      <Panel
        title="Rules"
        subtitle="What turns a reading into work — and the hysteresis that stops it flapping."
      >
        <RulesPanel
          rules={listConditionRules(db)}
          assets={assets}
          entities={ruleEntities}
          entitiesTruncated={linkable.truncated}
          parts={listPartOptions(db, { excludeKits: true }).map((part) => ({
            value: part.id,
            label: part.name,
            hint: part.spec ?? part.unit,
          }))}
          householdDefaults={{
            thresholdPct: household.batteryThresholdPct,
            clearPct: household.batteryClearPct,
            sustainMinutes: household.batterySustainMinutes,
            clearSustainMinutes: household.batteryClearSustainMinutes,
          }}
        />
      </Panel>

      <p className="text-xs leading-5 text-ink-3">
        <Badge tone="neutral" size="sm">
          unknown
        </Badge>{" "}
        and{" "}
        <Badge tone="neutral" size="sm">
          unavailable
        </Badge>{" "}
        are stored exactly as Home Assistant sends them and are never turned into a value. A battery
        entity reporting <code className="font-mono">unavailable</code> is a battery we know nothing
        about, which is not the same as a battery at 0 %.
      </p>
    </>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const STATE_LABEL: Record<IntegrationState, string> = {
  connecting: "Connecting",
  authenticating: "Authenticating",
  syncing: "Syncing the registry",
  subscribed: "Connected and subscribed",
  degraded: "Degraded",
  auth_failed: "The token was rejected",
  disconnected: "Disconnected",
};

const STATE_HELP: Record<IntegrationState, string> = {
  connecting: "Opening the WebSocket.",
  authenticating: "The socket is open; the token is being checked.",
  syncing: "Reading the area, floor, device and entity registries.",
  subscribed: "Receiving state changes as they happen.",
  degraded: "Connected, but something is not working as it should — see the last error.",
  auth_failed:
    "Home Assistant refused the token. Create a new long-lived token and put it in the secrets file; retrying will not help.",
  disconnected: "No socket. The worker retries with backoff.",
};

function Detail({
  term,
  value,
  children,
}: {
  term: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">{term}</dt>
      <dd className="vh-tnum text-sm text-ink">{value}</dd>
      {children === undefined ? null : (
        <dd className="max-w-prose text-xs leading-5 text-ink-3">{children}</dd>
      )}
    </div>
  );
}
