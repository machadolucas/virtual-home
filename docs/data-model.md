# Data model

SQLite, one file (`$VH_DATA_DIR/db/app.db`), opened by both the web and worker processes.
Schema lives in `src/db/schema/*.ts` (Drizzle), migrations in `drizzle/`, applied by
`src/db/migrate.ts`.

82 tables + 1 view. Source of truth is the schema files; the design passes in
`docs/design-notes/` are reference material only.

## Conventions

These are hard rules (CLAUDE.md). They are not negotiable per-table.

| Concept | Storage | Column suffix | Notes |
|---|---|---|---|
| Instant | `INTEGER` epoch milliseconds | `_ms` | Plain `integer('at_ms')` numbers — **never** Drizzle `{ mode: 'timestamp_ms' }`. Exact integer compare, trivial fake clocks, no `Date` picking up the process TZ. |
| Household local date | `TEXT` `YYYY-MM-DD` | — | Calendar facts ("due on 1 May"), not instants. Lexicographic order == chronological, so `BETWEEN`/`ORDER BY` work. |
| Local wall-clock time | `TEXT` `HH:MM` | — | `delivery_time`, `send_window_*`. Storing an instant would not survive DST. |
| Duration | `INTEGER` | `_minutes` / `_ms` | |
| Quantity | `INTEGER` thousandths | `_milli` | 2 pcs = `2000`, 2.5 L = `2500`. Exact integer stock math. |
| Money | `INTEGER` cents + `currency TEXT` | `_cents` | Default currency `'EUR'`. |
| Coordinates | `REAL` metres, model frame | `pos_x/_y/_z` | As supplied by the model package. |
| Identifier | `TEXT PRIMARY KEY`, UUIDv7 lowercase dashed | `id` | `newId()` in `src/db/ids.ts`. Sortable by creation time, type-compatible with Better Auth ids. |
| Boolean | `INTEGER` 0/1 | `is_*` / `has_*` / verb | Declared `integer(..., { mode: 'boolean' })`. |
| JSON blob | `TEXT` | `_json` | Parsed and validated with Zod at the boundary, never queried into. |

**Audit.** Hybrid, on purpose:

1. Every domain table carries `created_at_ms`, `created_by`, `updated_at_ms`, `updated_by` (the
   *audit quad*, or just the created pair for append-only tables). `*_by` columns are nullable —
   the worker and the HA inbound handler write rows with no user behind them — and reference
   `user.id` with `ON DELETE RESTRICT`, so actor attribution is never silently lost.
2. `audit_log` gets a row for *meaningful* changes only, written by the service layer.
3. **No SQLite triggers.** A trigger cannot see the actor; the service layer can, and is testable.
4. Immutable ledgers (`stock_transaction`, `completion`, `delivery_attempt`, `occurrence_event`)
   are their own audit trail; `audit_log` references them rather than duplicating their payload.

**Naming.** Tables singular snake_case (`maintenance_plan`), columns snake_case, Drizzle exports
camelCase (`maintenanceOccurrence`). Enum columns get a TS union via `$type<>()` plus a `CHECK`;
the union's values are exported as a `const` array next to the table (e.g. `OCCURRENCE_STATUSES`)
so Zod schemas and the UI reuse them.

**Writes.** Every write goes through `writeTx()` (BEGIN IMMEDIATE) from `src/db/client.ts`. WAL
allows one writer; a deferred transaction that reads first and writes later can fail to upgrade
and throw `SQLITE_BUSY` *mid-transaction*, which `busy_timeout` cannot rescue.

### The one exception: Better Auth

`src/db/schema/auth.ts` holds five tables Better Auth 1.7.3 owns — `user`, `session`, `account`,
`verification`, `rateLimit`. They keep **camelCase column names** and use
`integer(..., { mode: 'timestamp_ms' })` for instants, because the Drizzle adapter hands the driver
`Date` objects. Never copy that pattern anywhere else.

The adapter addresses tables as `schema[model]` and columns as `table[field]` — by the *JavaScript*
keys — so the export names and property names in that file are load-bearing and the SQL names are
not. `rateLimit` keeps its model name as its SQL table name so "table name == model name" holds for
all five. On a Better Auth upgrade, regenerate and diff rather than hand-editing:

```
pnpm dlx @better-auth/cli generate --config <throwaway config> --output <file> -y
```

The current column set was verified against `getSchema()` of the exact options in
`src/server/auth/auth.ts` (email+password, `username()` + `admin()` plugins,
`rateLimit.storage = 'database'`, `user.additionalFields.displayColor`, `generateId: 'uuid'`).

## Modules

Each module is one file in `src/db/schema/`. The barrel `index.ts` must list them all — it is both
the drizzle-kit schema and the object handed to Better Auth.

### `auth.ts` — identity (Better Auth, given)

| table | purpose |
|---|---|
| `user` | The household's people. `displayColor` is ours; `username`/`displayUsername` come from the username plugin, `role`/`banned`/`ban*` from the admin plugin. |
| `session` | Active sessions; `impersonatedBy` from the admin plugin. |
| `account` | Credential rows (the password hash lives here). |
| `verification` | Short-lived tokens (password reset). |
| `rateLimit` | Database-backed rate-limit counters. |

### `household.ts` — M0 settings, devices, audit

| table | purpose |
|---|---|
| `household_setting` | Singleton (`id = 'household'`) holding every runtime tunable: time zone, delivery time, reminder interval, send window, catch-up thresholds, battery hysteresis, reorder horizon, current model pointer. |
| `user_notify_device` | Which `notify.mobile_app_*` service reaches which user. |
| `audit_log` | Generic "who changed what" trail for meaningful changes. |

### `model.ts` — M1 place & 3D model

| table | purpose |
|---|---|
| `model_revision` | One import of the supplied model package, content-hashed so re-import is a no-op. |
| `model_node` | The node tree of a revision (building/floor/room/zone/surface/element) keyed by the package's semantic ids. |
| `model_node_alias` | Remembered revision→revision id remaps, so the next import follows earlier decisions. |
| `location` | The single spatial tree (property > building > floor > room, plus outdoor zones). Everything spatial points at one `location_id`. |
| `location_mapping` | HA area/floor ↔ our location, `suggested`/`confirmed`/`rejected`. Never auto-confirmed. |
| `model_reconciliation` | A reconciliation plan produced by importing a new revision. |
| `model_reconciliation_item` | One affected row, its candidate new nodes, and the human's decision. |
| `surface_color_override` | A surface's chosen colour, keyed by `model_id` + semantic `surface_id` so it survives a revision import. |

### `assets.ts` — M2 assets & systems

| table | purpose |
|---|---|
| `asset` | A physical (or virtual/software) unit. Replacement creates a new row and links the two. |
| `asset_placement` | Where the asset sits in the model: revision + node + metres + kind (`body`/`access_panel`/`label`/`shutoff`). |
| `asset_consumable` | What an asset eats (N of part P in role `battery`/`filter`/…). |
| `asset_replacement` | Audit-grade record of a swap. |
| `system` | A functional system (ventilation, water, electrical, network …). |
| `system_asset` | Which assets belong to a system. |
| `system_location` | Which locations a system spans. |
| `asset_ha_link` | Asset ↔ HA, keyed by registry id with `entity_id` kept only as an informational snapshot. |

### `procedures.ts` — M3 procedures

| table | purpose |
|---|---|
| `procedure` | A named, slugged procedure with a pointer to its current published version. |
| `procedure_version` | Immutable once published; editing forks a new draft. |
| `procedure_step` | Ordered steps. |
| `procedure_checklist_item` | Step-level or version-level checklist entries, optionally capturing a value. |
| `procedure_tool` | Tools needed. |
| `procedure_material` | Parts needed, in thousandths. |
| `procedure_reference` | Manual name + page range, URL, or an attachment. |
| `procedure_equipment_note` | Model-specific caveats ("on the 2019 model the clip is reversed"). |

### `maintenance.ts` — M4 maintenance

| table | purpose |
|---|---|
| `maintenance_plan` | A recurring or one-off obligation against exactly one target (asset **or** system **or** location), with its recurrence rule and schedule anchor. |
| `plan_material` | Plan-level expected materials. |
| `maintenance_occurrence` | The unit of work and of notification; snapshots the plan's fields at generation time. |
| `occurrence_progress_item` | Resumable guided-procedure progress; retained after completion. |
| `occurrence_event` | Typed domain timeline driving the UI. |
| `completion` | The factual record that work happened, idempotent on `request_id`. |
| `completion_material` | What was actually consumed, with expected/actual/shortfall and the ledger row it wrote. |
| `service_provider` | A tradesperson or company. |
| `service_booking` | A booking, with its own status. Booking and attendance are never completion. |
| `service_document` | Quote/invoice/receipt/certificate, optionally attached. |

### `inventory.ts` — M5 inventory

| table | purpose |
|---|---|
| `part` | SKU-level part: `discrete`/`measured`/`estimated`, `stocked`/`not_stocked`, reorder thresholds. |
| `kit_component` | Bill-of-materials metadata only. Never used for availability arithmetic. |
| `part_compatibility` | "This filter fits that unit", with a confidence. |
| `part_supplier` | Where to buy it; at most one preferred supplier per part. |
| `storage_place` | "Garage shelf B, bin 3", nestable, pinned to a location. |
| `part_lot` | Optional per-lot expiry / opened state / estimated-remaining dial. |
| `stock_transaction` | Append-only signed ledger. Never updated, never deleted. |
| `part_stock` | **View**: `on_hand_milli`, `effective_milli` (excludes future-dated rows), `last_movement_ms`. |
| `app_alert` | In-app warnings, deduped by `dedupe_key` while unresolved. |

Stock is tracked only where the goods physically sit, so
`available(part) = SUM(stock_transaction.qty_milli WHERE part_id = part)` — full stop. There is no
`+ kits × ratio` term anywhere. Opening a box is an explicit "kit explode": one consumption of the
kit plus one addition per component, sharing a `transaction_group_id`. Negative balances are
allowed; that is how a noted discrepancy is represented honestly.

### `infrastructure.ts` — M6 infrastructure & projects

| table | purpose |
|---|---|
| `infra_route` | A pipe / duct / cable run, with `medium`, `certainty` (`measured`/`observed`/`inferred`/`unknown`) and `lifecycle` (`planned`/`installed`/`removed`). |
| `infra_route_point` | The route's polyline in model-frame metres. |
| `infra_endpoint` | Source, terminal, junction, meter, shutoff, panel, patch port. |
| `annotation` | A pin in the model: note, measurement, warning, to-do, photo viewpoint. |
| `project` | A renovation / repair / installation with budget and status. |
| `project_link` | Polymorphic link from a project to anything else. |

### `ha.ts` — M7 HA cache & conditions

| table | purpose |
|---|---|
| `ha_floor`, `ha_area` | Registry cache of HA's spatial model. |
| `ha_device` | Device registry cache, plus the chosen `canonical_battery_entity_id`. |
| `ha_entity` | Entity registry cache keyed by the stable registry entry id. |
| `ha_entity_rename` | Paper trail of `entity_id` renames. |
| `ha_sync_run` | One row per registry sync, with counts. |
| `ha_connection_state` | Singleton (`id = 'ha'`) written by the worker's socket state machine. |
| `integration_status` | What both processes read for health; `heartbeat_at_ms` separates "worker alive" from "HA reachable". |
| `condition_rule` | A rule turning HA readings into work, with explicit hysteresis. |
| `condition_signal` | **Latest value only** — no telemetry history is copied into this database. |
| `condition_episode` | The condition history worth keeping: one row per "went low, then came back". |

Registry rows are **soft-deleted** (`removed_at_ms`), never hard-deleted, because links point at
them. `unknown`/`unavailable` is never a value — that is what `condition_signal.is_valid` and
`invalid_reason` record.

### `notifications.ts` — M8 notifications & worker

| table | purpose |
|---|---|
| `notification_recipient_state` | One row per (occurrence, recipient), with the stable notification `tag`. |
| `reminder_slot` | The scheduling truth: one slot per send, with its nonce and claim fields. |
| `ha_notify_command` | Transport outbox, so a clear survives an HA outage. Clears drain before notifies. |
| `delivery_attempt` | Immutable attempt log. `accepted` means HA took the call, nothing more. |
| `notification_action_event` | Every inbound HA action, accepted or not — forensics plus the replay guard. |
| `worker_lease` | Named leases with a fence token (`notification_tick`, `ha_listener`, `outbox_drain`). |
| `worker_heartbeat` | How the worker learns, after a restart, that an outage happened. |

### `attachments.ts` — M9 shared

| table | purpose |
|---|---|
| `attachment` | File metadata; bytes live on disk under `$VH_DATA_DIR/attachments`, never as blobs. `sha256` gives free dedupe. |
| `attachment_link` | Polymorphic link to whatever the file documents, with a role (`before`/`after`/`nameplate`/`receipt`). |
| `export_run` | One row per JSON/CSV export. |

### `system.ts` — platform

| table | purpose |
|---|---|
| `event_outbox` | Worker→web notification channel (autoincrement id, polled by the SSE hub). |
| `event_cursor` | Single row (`id = 1`) bumped in the same transaction as the insert, so readers never see a counter without its rows. |
| `idempotency_key` | Server-action replay store; a reaper deletes keys older than 24 h. |
| `process_metric` | RSS/heap/uptime samples from both processes; pruned to 14 days. |
| `backup_run` | One row per `scripts/backup.sh` run. A *missing* row is the alert. |

## Invariants enforced by the database

**Partial unique indexes** — the load-bearing concurrency guards. These are the reason a restart or
a second worker cannot double-write; there is physically no second row to claim.

| index | guarantee |
|---|---|
| `ux_occ_open_per_plan` | At most one open (`pending`/`due`) occurrence per plan, ever. |
| `ux_occ_open_per_condition` | At most one open condition-derived occurrence per (rule, asset), via the generated `condition_rule_key`. |
| `ux_slot_one_open` | At most one non-terminal (`pending`/`claimed`) reminder slot per recipient state. |
| `ux_action_replay` | At most one *accepted* `(nonce, action)`; the second insert fails and the handler records `duplicate` + `noop`. |
| `ux_completion_live_per_occurrence` | At most one non-voided completion per occurrence. |
| `ux_model_revision_current` | At most one `current` revision per model. |
| `ux_model_reconciliation_open` | At most one open reconciliation per target revision. |
| `ux_procedure_version_draft` | At most one draft per procedure. |
| `ux_condition_episode_open` | At most one open episode per (rule, entity). |
| `ux_app_alert_dedupe` | At most one unresolved alert per `dedupe_key`; re-raising bumps counters instead of adding noise. |
| `ux_ha_entity_entity_id`, `ux_ha_entity_unique_id` | HA identity uniqueness among **live** (non-removed) rows only. |
| `ux_part_supplier_preferred` | At most one preferred supplier per part. |
| `ux_part_product_code`, `ux_part_compatibility_asset`, `ux_location_model_node`, `ux_location_mapping_confirmed_area`, `ux_asset_ha_link_role`, `ux_stock_transaction_reverses` | Uniqueness that only applies when the relevant column is set. |

**CHECK constraints** (~168 of them) cover: every enum column; non-negative and strictly-positive
quantities, prices and counts; percentage ranges; `HH:MM` and `#rrggbb` shapes (via `GLOB`); and
field co-dependence, e.g.

- `household_setting.id = 'household'`, `ha_connection_state.id = 'ha'`, `event_cursor.id = 1`;
- `maintenance_plan`: exactly one of `asset_id`/`system_id`/`location_id`;
- `maintenance_plan` / `condition_rule`: `(assignment_mode = 'user') = (assignee_user_id IS NOT NULL)`;
- `maintenance_occurrence`: `(status = 'completed') = (completion_id IS NOT NULL)` and
  `(status IN ('completed','skipped','cancelled')) = (closed_at_ms IS NOT NULL)`;
- `completion`: at least one of `performed_by_user_id` / `performed_by_provider_id`;
- `stock_transaction`: `qty_milli <> 0`, `consumption` must be negative, and
  `purchase`/`initial_count`/`kit_explode_in` must be positive;
- `asset_ha_link`: `(link_kind = 'device') = (ha_device_id IS NOT NULL AND ha_entity_registry_id IS NULL)`;
- `location`: `(kind = 'property') = (parent_id IS NULL)`;
- `part`: `is_kit = 1 OR stock_mode = 'stocked'` — non-kit parts are always stocked.

**Foreign keys.** `PRAGMA foreign_keys = ON` on every connection (it is per-connection). Default
`ON DELETE RESTRICT` towards `user` — actor attribution is never lost. `CASCADE` only where the
child is genuinely part of the parent (`procedure_version` children, `occurrence_progress_item`,
`reminder_slot`, `delivery_attempt`, `attachment_link`, `model_node`). `SET NULL` for optional
cross-references whose loss is survivable (`asset_ha_link` → registry rows, `attachment_id`).

## Invariants enforced in code (and tested), not by the database

SQLite cannot express these, so they live in the service layer with tests:

- **Location tree shape**: allowed parent kinds (`building→property`, `floor→building`,
  `room→floor`, `zone→property|building`); no cycles (walk to root, depth ≤ 8).
- **Acyclic chains**: asset parent/replacement chains, `kit_component` (depth ≤ 3),
  `storage_place.parent_place_id`, `ha_device.via_device_id`.
- **Asset lifecycle**: `status IN ('removed','retired')` ⇒ `removed_on` set;
  `replaced_by_asset_id` set ⇒ status is `removed`/`retired`; both sides of a replacement written in
  one transaction.
- **Procedure immutability**: a `published` version and all its children are read-only; any edit
  forks a new draft.
- **Discrete parts**: every `qty_milli` for a `tracking_mode = 'discrete'` part is a multiple of
  1000. (A `CHECK` on `unit` would be too strong.)
- **Polymorphic links** (`attachment_link`, `project_link`, `model_reconciliation_item`,
  `annotation`): existence is validated on insert, and a nightly integrity job reports dangling
  rows into `app_alert`.
- **`audit_log.actor_user_id`** is required when `actor_kind = 'user'`.
- **Notify devices**: a user with assignments must have ≥ 1 active device, else notifications are
  recorded as `failed_no_device` and an `app_alert` is raised.
- **Placement writes** are accepted only from an explicit "set placement" call carrying
  `viewMode: 'normal'`; `exploded`/`cutaway` requests are rejected with 422. Those transforms are
  presentation state and have no table.
- **Never fabricate history**: setup writes a *schedule anchor*, not a completion. Snooze changes
  only reminders. A booking (even `attended`) is not a completion.

## Notable decisions worth knowing

- **`part_stock` is a view, not a cache table.** No drift, no invalidation bug. Data volume is
  hundreds to low thousands of rows and the `(part_id, occurred_at_ms)` index makes the `SUM`
  microseconds. Revisit only if a single part exceeds ~50k transactions.
- **`maintenance_occurrence.condition_rule_key` is a VIRTUAL generated column**
  (`condition_rule_id || ':' || coalesce(asset_id, '')`). It exists only so
  `ux_occ_open_per_condition` can be a composite partial unique index — SQLite allows either
  multiple columns or a predicate, but a predicate plus a concatenation needs an indexable
  expression. VIRTUAL means no storage and no rewrite cost.
- **`maintenance_occurrence.condition_rule_id`** is not in the design's column list, but the
  design's own index definition references it; it is added here (nullable, FK to `condition_rule`,
  with `CHECK ((source = 'condition') = (condition_rule_id IS NOT NULL))`) because the index cannot
  exist without it. `surface_color_override` is likewise added to
  `model_reconciliation_item.entity_kind`, since it carries `model_revision_id` and
  `needs_reconciliation` like the other spatial tables.
- **`attachment` merges two design passes.** The domain pass (§1.10) and the platform pass (§9.2)
  described the same table differently; this schema takes the domain pass's column set and naming
  and adds the platform pass's `has_web_copy`, which the upload pipeline needs.
- **`backup_run.created_at_ms`.** The design note's `backup.sh` snippet writes a column called
  `created_at`; the epoch-ms `*_ms` convention wins, so the column is `created_at_ms`. Whoever
  writes `scripts/backup.sh` must use that name.
- **Placeholder seeds.** `household_setting.display_name` seeds as `'Home'` and
  `current_model_id` as `'unset'` — real household values are private data and never enter this
  repository. Setup and the model import replace them.
- **drizzle-kit emitted everything.** Partial indexes, CHECK constraints, the generated column and
  the view are all in `drizzle/0000_solid_legion.sql`; no hand-written migration was needed.

## How to change the schema

Forward-only and additive-first. There is no `down` migration; a mistake is fixed by a new
migration, not by rewriting history.

1. **Edit** the table in `src/db/schema/*.ts`. New table? Add the file to `src/db/schema/index.ts`
   — a table missing from the barrel is invisible to both drizzle-kit and the runtime.
2. **Generate**: `pnpm db:generate`. This reads only the schema; it never touches a database.
3. **Review the SQL** in `drizzle/000N_*.sql` before anything else. Check specifically that
   partial index predicates, CHECK constraints, generated columns and views came out as intended —
   and that the migration does not rewrite a table you did not mean to touch. SQLite implements
   most `ALTER` as create-copy-drop-rename, which is where data gets lost.
4. **Test**: `pnpm exec vitest run tests/integration`. `tests/integration/migrations.test.ts`
   snapshots `sqlite_master`, so an unintended change shows up as a snapshot diff — update the
   snapshot (`-u`) only once you have read the diff and agree with it.
5. **Migrate**: `pnpm db:migrate` (production takes a `--keep-forever` backup first).
6. **Document** the new table or column here, in the module table above.

Prefer additive changes: new nullable column, new table, new index. When a column genuinely must
change shape, do it in two releases — add the new column and backfill, switch the readers, then
drop the old column in a later migration — so a rollback never loses data.

`pnpm db:migrate` needs the configuration in its environment (`src/env.ts` validates it and exits
78 if it is missing). In development, export `.env.local` first:

```bash
set -a; . ./.env.local; set +a; pnpm db:migrate
```

`runMigrations()` also seeds the singletons every run, idempotently: `household_setting`,
`event_cursor` (`id = 1`), `ha_connection_state` (`id = 'ha'`) and `integration_status`
(`id = 'ha'`). It never overwrites a value a human has since changed.
