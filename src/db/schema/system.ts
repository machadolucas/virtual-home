/**
 * Platform tables: the worker→web event outbox and its cursor, the server-action idempotency
 * store, process metrics, and the backup run log.
 *
 * Design: `docs/design-notes/auth-security-operations.md` §7.2, §3.5, §11.4, §10.1.
 *
 * These are the only tables with `integer` autoincrement primary keys: `event_outbox` needs a
 * monotonic sequence the SSE hub can poll, and `process_metric` is a high-volume, pruned time
 * series where a UUID per row would be pure overhead.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

/**
 * Worker→web notification channel (SQLite outbox + 1 s poll). Rows are coalesced before the write
 * (last-write-wins per `entity_key`), and retained for a short window then pruned.
 */
export const eventOutbox = sqliteTable(
  "event_outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** `'ha.state'` | `'task.changed'` | `'integration.status'` | … */
    topic: text("topic").notNull(),
    /** Coalescing key, e.g. `'light.kitchen'`. */
    entityKey: text("entity_key"),
    payloadJson: text("payload_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("ix_event_outbox_created").on(t.createdAtMs),
    index("ix_event_outbox_topic").on(t.topic, t.entityKey),
  ],
);

export const EVENT_CURSOR_ID = 1;

/**
 * Single row (`id = 1`). Written in the **same transaction** as the outbox insert, so readers never
 * see a bumped counter without the rows — and it survives retention deletes, where `MAX(id)` would
 * return NULL on an emptied table.
 */
export const eventCursor = sqliteTable(
  "event_cursor",
  {
    id: integer("id").primaryKey(),
    seq: integer("seq").notNull().default(0),
  },
  (t) => [check("ck_event_cursor_singleton", sql`${t.id} = 1`)],
);

/**
 * Server-action idempotency store. A mutating action carrying an `idempotencyKey` replays the
 * stored result instead of running twice; the client creates the key once per form instance, not
 * per submit. A reaper deletes keys older than 24 h.
 */
export const idempotencyKey = sqliteTable(
  "idempotency_key",
  {
    key: text("key").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    responseJson: text("response_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [index("ix_idempotency_key_created").on(t.createdAtMs)],
);

export const PROCESS_ROLES = ["web", "worker", "cli"] as const;
export type ProcessMetricRole = (typeof PROCESS_ROLES)[number];

/**
 * One row per process per `VH_METRICS_INTERVAL_MS` from `process.memoryUsage()` +
 * `process.uptime()`. The worker prunes rows older than 14 days hourly.
 */
export const processMetric = sqliteTable(
  "process_metric",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    role: text("role").$type<ProcessMetricRole>().notNull(),
    pid: integer("pid").notNull(),
    rssBytes: integer("rss_bytes").notNull(),
    heapUsedBytes: integer("heap_used_bytes").notNull(),
    externalBytes: integer("external_bytes").notNull(),
    uptimeS: integer("uptime_s").notNull(),
    atMs: integer("at_ms").notNull(),
  },
  (t) => [
    check("ck_process_metric_role", sql`role IN ('web', 'worker', 'cli')`),
    index("ix_process_metric_at").on(t.atMs),
    index("ix_process_metric_role_at").on(t.role, t.atMs),
  ],
);

/**
 * One row per `scripts/backup.sh` run. Recording it here is what makes "last backup" showable on
 * `/settings/system` — and a *missing* row is the alert.
 *
 * `label` distinguishes `nightly` from the `--keep-forever` pre-migration and pre-update snapshots.
 */
export const backupRun = sqliteTable(
  "backup_run",
  {
    id: text("id").primaryKey(),
    createdAtMs: integer("created_at_ms").notNull(),
    label: text("label").notNull(),
    path: text("path").notNull(),
    bytes: integer("bytes").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    error: text("error"),
  },
  (t) => [
    check("ck_backup_run_bytes", sql`bytes >= 0`),
    index("ix_backup_run_created").on(t.createdAtMs),
  ],
);
