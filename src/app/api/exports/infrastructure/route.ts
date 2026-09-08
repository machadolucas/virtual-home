/**
 * GET /api/exports/infrastructure
 *
 * Everything recorded about the house's hidden systems: routes with their points, endpoints,
 * annotations and projects — wrapped in the envelope from
 * `docs/design-notes/domain-scheduling-inventory.md` §8.4.
 *
 * The envelope is the feature. A CSV of `pos_x, pos_y, pos_z` is worthless in ten years unless it
 * also says which model, which revision, which content hash and which coordinate frame those
 * metres are in. So every response carries `model.coordinateSystem`, and a response produced before
 * any model import carries `model: null` rather than a plausible-looking default.
 *
 * | Query | Response |
 * |---|---|
 * | (none) or `format=json` | the whole envelope, routes carrying their points inline |
 * | `format=csv` | `_manifest.csv`: the dataset names, row counts and their download URLs |
 * | `format=csv&dataset=<name>` | that one dataset as CSV |
 * | `format=context` | `_context.json`: the envelope without the rows, to file beside the CSVs |
 *
 * One HTTP response cannot be six files, which is why CSV mode serves one dataset per request. A
 * single zip is a deliberate follow-up, not an oversight (`docs/model-contract.md`).
 *
 * Each request records an `export_run` row: who asked, for what, and how many rows they got. An
 * export leaves the household's data on a laptop somewhere, so it is worth knowing it happened.
 */
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { exportRun } from "@/db/schema";
import { authed, badRequest } from "@/server/api/handler";
import {
  INFRA_DATASETS,
  collectInfrastructure,
  contextJson,
  infrastructureJson,
  isInfraDataset,
  manifestCsv,
  toCsv,
} from "@/server/queries/infrastructure/exportInfrastructure";

export const dynamic = "force-dynamic";

/** Private, never cached: this is the household's own data leaving the building. */
const NO_STORE = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const;

export const GET = authed(async (session, req) => {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "json";
  const dataset = url.searchParams.get("dataset");
  if (format !== "json" && format !== "csv" && format !== "context")
    throw badRequest("unsupported_format", { format, supported: ["json", "csv", "context"] });
  if (dataset !== null && !isInfraDataset(dataset))
    throw badRequest("unknown_dataset", { dataset, datasets: INFRA_DATASETS });

  const handle = getDb();
  const at = nowMs();
  const stamp = new Date(at).toISOString().slice(0, 10);

  const record = (rowCounts: Record<string, number>): void => {
    writeTx(handle.db, (tx) => {
      tx
        .insert(exportRun)
        .values({
          id: newId(),
          requestedBy: session.user.id,
          format: format === "csv" ? "csv" : "json",
          datasetsJson: JSON.stringify(dataset ? [dataset] : INFRA_DATASETS),
          startedAtMs: at,
          finishedAtMs: nowMs(),
          status: "done",
          rowCountsJson: JSON.stringify(rowCounts),
        })
        .run();
    });
  };

  if (format === "csv") {
    if (dataset === null) {
      const body = manifestCsv(handle, at);
      record({});
      return csv(body, `infrastructure-manifest-${stamp}.csv`);
    }
    const rows = collectInfrastructure(handle.db)[dataset];
    record({ [dataset]: rows.length });
    return csv(toCsv(rows), `infrastructure-${dataset}-${stamp}.csv`);
  }

  if (format === "context") {
    const body = contextJson(handle, at);
    return new Response(body, {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="infrastructure-context-${stamp}.json"`,
      },
    });
  }

  const envelope = infrastructureJson(handle, at);
  record(envelope.rowCounts);
  return Response.json(envelope, { headers: NO_STORE });
});

function csv(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
