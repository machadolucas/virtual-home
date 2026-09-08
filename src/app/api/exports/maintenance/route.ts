/**
 * GET /api/exports/maintenance — the maintenance datasets, with the §8.4 envelope.
 *
 * Behind `authed()` like every other handler (CLAUDE.md rule 2): this is the household's whole
 * maintenance record and it never leaves the app unauthenticated.
 *
 * Two shapes:
 *  - `?format=json` (default) — one document: the envelope plus every requested dataset, with
 *    material lines nested inside their completion.
 *  - `?format=csv&dataset=completions` — a single flat table. CSV is one dataset per request
 *    rather than a zip, because bundling would mean adding an archiver dependency to serve two
 *    users on a LAN; the envelope travels in the `X-VH-Export-Context` header and in
 *    `?format=json` for anyone who needs the frame.
 */
import { getDb } from "@/db/client";
import { systemClock } from "@/domain/time";
import { authed, badRequest } from "@/server/api/handler";
import {
  MAINTENANCE_DATASETS,
  buildDataset,
  buildExportContext,
  buildMaintenanceExport,
  isMaintenanceDataset,
  toCsv,
  type MaintenanceDataset,
} from "@/server/queries/maintenance/export";

export const dynamic = "force-dynamic";

const NO_STORE = "private, no-store";

export const GET = authed(async (_session, req) => {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "json";
  const requested = url.searchParams
    .getAll("dataset")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const name of requested) {
    if (!isMaintenanceDataset(name)) {
      throw badRequest("unknown_dataset", { dataset: name, known: MAINTENANCE_DATASETS });
    }
  }
  const datasets: MaintenanceDataset[] =
    requested.length > 0
      ? [...new Set(requested.filter(isMaintenanceDataset))]
      : [...MAINTENANCE_DATASETS];

  const { db } = getDb();
  const nowMs = systemClock.now();
  const stamp = new Date(nowMs).toISOString().slice(0, 10);

  if (format === "csv") {
    if (datasets.length !== 1) {
      throw badRequest("csv_needs_one_dataset", {
        message: "CSV returns one table; pass exactly one ?dataset=…",
        known: MAINTENANCE_DATASETS,
      });
    }
    const dataset = datasets[0]!;
    const context = buildExportContext(db, nowMs);
    const rows = buildDataset(db, dataset, context.household.timezone);
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="virtual-home-${dataset}-${stamp}.csv"`,
        "Cache-Control": NO_STORE,
        // The frame the numbers are expressed in, for a CSV opened years later.
        "X-VH-Export-Context": JSON.stringify(context),
      },
    });
  }

  if (format !== "json") throw badRequest("unknown_format", { format, known: ["json", "csv"] });

  const envelope = buildMaintenanceExport(db, nowMs, datasets);
  return new Response(JSON.stringify(envelope, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="virtual-home-maintenance-${stamp}.json"`,
      "Cache-Control": NO_STORE,
    },
  });
});
