No existing codebase (the working directory holds only unrelated session folders), so this is a greenfield design. Here is the design document.

---

# virtual-home — Domain Model, Persistence, Scheduling & Inventory Design

**Status:** implementation-ready design. Target: Next.js 16 App Router + a sibling Node worker, SQLite/Drizzle 0.45/better-sqlite3, Better Auth, Home Assistant 2026.9.

---

## 0. Cross-cutting conventions (decide once, apply everywhere)

### 0.1 Time representation

| Concept | Storage | TS type | Rationale |
|---|---|---|---|
| Instant | `INTEGER` epoch milliseconds, column suffix `_ms` | `type Instant = number` (branded) | Integer compare/index is exact and cheap; no chance of two processes writing different ISO offset formats; `Date.now()` maps directly; fake-clock tests are trivial (`clock.now = 1_800_000_000_000`). Text ISO would allow `Z` / `+03:00` / space-separated variants to coexist and break range queries. |
| Household local date | `TEXT` `YYYY-MM-DD` | `type LocalDate = string` (branded) | These are calendar facts ("due on 1 May"), not instants. Lexicographic order == chronological order, so `BETWEEN` and `ORDER BY` work. |
| Local wall-clock time | `TEXT` `HH:MM` (24h) | `type LocalTime = string` | Delivery time must survive DST; storing an instant would not. |
| Duration | `INTEGER` minutes (`_minutes`) or ms (`_ms`) | `number` | — |
| Quantity | `INTEGER` thousandths (`_milli`) | `type Milli = number` | Exact integer stock math; no float drift when summing hundreds of transactions. `2.5 L` → `2500`. Display divides by 1000. |
| Money | `INTEGER` cents (`_cents`) + `currency TEXT DEFAULT 'EUR'` | `number` | — |
| Coordinates | `REAL` metres (`pos_x/pos_y/pos_z`) | `number` | Model frame, metres, as supplied. |

Drizzle: use `integer('created_at_ms')` with default `{ mode: 'number' }`, **not** `mode: 'timestamp_ms'`. Rationale: the domain layer works with a plain `Instant` number, the fake clock is injectable, and no `Date` object silently picks up the process TZ.

All calendar math goes through one module, `src/domain/time.ts`, wrapping `date-fns` + `@date-fns/tz`:

```ts
export interface Clock { now(): Instant }
export const systemClock: Clock = { now: () => Date.now() };

/** Local date + local time in tz -> instant. DST-safe. */
export function instantOf(date: LocalDate, time: LocalTime, tz: string): Instant;
/** Instant -> local date in tz. */
export function localDateOf(at: Instant, tz: string): LocalDate;
export function addDaysLocal(d: LocalDate, n: number): LocalDate;
export function addMonthsClamped(d: LocalDate, n: number): LocalDate; // month-end clamp
export function lastDayOfMonth(year: number, month1to12: number): number;
```

`instantOf` DST edge rules (must be implemented and tested explicitly, because `TZDate` construction is lenient):

1. **Nonexistent local time** (spring forward gap, Helsinki 03:00–03:59 on the DST start date): return the **first valid instant at or after** the requested wall time (i.e. `04:00` local). Record nothing special; log at debug.
2. **Ambiguous local time** (autumn fall-back, Helsinki 03:00–03:59 occurring twice): return the **earlier (DST) occurrence**.
3. `09:00` (the default delivery time) is never affected in Helsinki, but the rules must hold because delivery time is configurable.

### 0.2 Identifiers

All primary keys are `TEXT PRIMARY KEY` holding a **UUIDv7** (lowercase hex, dashed) generated in the app. Sortable by creation time, matches Better Auth's `TEXT` ids so FKs are type-compatible, and lets the web process create rows without a round-trip.

### 0.3 SQLite / better-sqlite3 setup

Both processes open the same file and run the same pragma set at connection open (`src/db/connect.ts`):

```
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;      -- per-connection, required for FK enforcement
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
```

**All write transactions use `BEGIN IMMEDIATE`** (Drizzle: `db.transaction(fn, { behavior: 'immediate' })`). Reason: WAL permits one writer; a deferred transaction that starts with a read and later writes can fail to upgrade and throw `SQLITE_BUSY` *mid-transaction*, which `busy_timeout` does not retry. `IMMEDIATE` takes the write lock up front so `busy_timeout` applies.

Read transactions stay deferred. The worker wraps each write transaction in a bounded retry (5 attempts, 50/100/200/400/800 ms jitter) for `SQLITE_BUSY`.

### 0.4 Invariant enforcement policy

- **SQLite `CHECK` constraints** for enums, non-negative amounts, and simple field co-dependence. SQLite supports these and drizzle-kit emits them. Use them; they are the cheapest guard against a bad migration or a manual `sqlite3` session.
- **Partial unique indexes** (`CREATE UNIQUE INDEX … WHERE …`) for the "at most one open X" invariants. These are the load-bearing concurrency guards.
- **Code-level invariants** (documented per table, asserted in the service layer and covered by tests) for anything cross-row or cross-table: parent-kind rules in the location tree, "completion materials must reference parts, not kits, unless the kit is stocked", etc.

### 0.5 Naming

Domain tables: singular snake_case (`maintenance_plan`), columns snake_case. Better Auth's four tables keep their camelCase columns exactly as the library generates them. This mixed convention is accepted and confined to those four tables; the domain never joins on their non-`id` columns.

---

## 1. Entity-relationship overview and schema

### 1.1 Module overview

**M0 — Identity & settings**
`user` / `session` / `account` / `verification` (Better Auth, unchanged) · `household_setting` (singleton) · `user_notify_device` (which `notify.mobile_app_*` service reaches which user) · `audit_log`.

**M1 — Place & 3D model**
`model_revision` → `model_node` (tree of building/floor/room/zone/surface/element with stable ids) · `model_node_alias` (revision→revision id remaps) · `location` (single self-referencing tree: property > building > floor > room, plus outdoor zones) · `location_mapping` (HA area/floor ↔ location, suggested or confirmed) · `model_reconciliation` → `model_reconciliation_item`.

**M2 — Assets & systems**
`asset` (physical equipment; may have zero or many HA representations; `replaces_asset_id` / `replaced_by_asset_id` chain) · `asset_placement` (asset ↔ model node + metres position, revision-stamped) · `asset_consumable` (asset needs N of part P in role `battery`/`filter`/`bag`) · `asset_replacement` (audit-grade record of a swap) · `system` (ventilation, water, electrical, network) · `system_asset`, `system_location` (systems span locations) · `asset_ha_link`.

**M3 — Procedures**
`procedure` → `procedure_version` (immutable once published) → `procedure_step` → `procedure_checklist_item` · `procedure_tool` · `procedure_material` · `procedure_reference` (manual name + page, URL) · `procedure_equipment_note` · attachments via M8.

**M4 — Maintenance**
`maintenance_plan` (recurrence rule JSON, assignment, effort, priority, schedule anchor separate from completion history) · `plan_material` · `maintenance_occurrence` (exactly one open per recurring plan) · `occurrence_progress_item` (resumable guided-procedure progress) · `occurrence_event` (typed timeline) · `completion` → `completion_material` · `service_provider` · `service_booking` · `service_document`.

**M5 — Inventory**
`part` (SKU-level: discrete / measured / estimated) · `part_compatibility` · `kit_component` · `part_supplier` · `storage_place` · `part_lot` (optional expiry/opened) · `stock_transaction` (append-only ledger) · `part_stock` (SQL view) · `reorder_policy` · `app_alert` (in-app warnings, not push).

**M6 — Infrastructure & projects**
`infra_route` → `infra_route_point` · `infra_endpoint` · `annotation` · `project` → `project_link`.

**M7 — HA integration & conditions**
`ha_connection_state` · `ha_sync_run` · `ha_floor` · `ha_area` · `ha_device` · `ha_entity` · `ha_entity_rename` · `condition_rule` · `condition_signal` (latest value only) · `condition_episode`.

**M8 — Notifications & worker**
`notification_recipient_state` · `reminder_slot` · `ha_notify_command` (transport outbox) · `delivery_attempt` · `notification_action_event` · `worker_lease` · `worker_heartbeat`.

**M9 — Shared**
`attachment` · `attachment_link` (polymorphic, code-enforced) · `export_run`.

Relationship spine, in one line each:

- `location` is the single spatial tree; everything spatial points at `location_id` and, optionally, at a `model_revision_id` + `model_node_id` + metres position.
- `asset` points at `location_id`; replacement creates a **new** `asset` row and links the two.
- `maintenance_plan` points at exactly one target: `asset_id` **or** `system_id` **or** `location_id` (exactly one non-null).
- `maintenance_occurrence` is the unit of work and the unit of notification; it snapshots plan fields at generation time so editing a plan never rewrites open work.
- `completion` snapshots `asset_id` and `procedure_version_id` so history stays attached to the unit that was actually serviced.
- `stock_transaction` is append-only; `completion` is the reason code for consumption rows.

### 1.2 Better Auth tables (given — do not redesign)

Generated by `npx @better-auth/cli generate` with the username plugin; reproduced here so the ERD is complete. Never hand-edit; regenerate on Better Auth upgrades.

| table | columns |
|---|---|
| `user` | `id` TEXT PK · `name` TEXT NOT NULL · `email` TEXT NOT NULL UNIQUE · `emailVerified` INTEGER NOT NULL · `image` TEXT NULL · `createdAt` INTEGER NOT NULL · `updatedAt` INTEGER NOT NULL · `username` TEXT NULL UNIQUE · `displayUsername` TEXT NULL |
| `session` | `id` TEXT PK · `expiresAt` INTEGER NOT NULL · `token` TEXT NOT NULL UNIQUE · `createdAt` · `updatedAt` · `ipAddress` TEXT NULL · `userAgent` TEXT NULL · `userId` TEXT NOT NULL → `user.id` ON DELETE CASCADE |
| `account` | `id` TEXT PK · `accountId` TEXT NOT NULL · `providerId` TEXT NOT NULL · `userId` TEXT NOT NULL → `user.id` CASCADE · `accessToken` · `refreshToken` · `idToken` · `accessTokenExpiresAt` · `refreshTokenExpiresAt` · `scope` · `password` TEXT NULL · `createdAt` · `updatedAt` |
| `verification` | `id` TEXT PK · `identifier` TEXT NOT NULL · `value` TEXT NOT NULL · `expiresAt` INTEGER NOT NULL · `createdAt` · `updatedAt` |

Domain tables reference `user.id` with `ON DELETE RESTRICT` (never lose actor attribution; two users, neither is going to be deleted).

### 1.3 M0 — settings, devices, audit

**`household_setting`** — singleton (`id` fixed to `'household'`).

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | `CHECK (id = 'household')` |
| `display_name` | TEXT | no | e.g. "Example House 1" |
| `timezone` | TEXT | no | default `'Europe/Helsinki'` |
| `delivery_time` | TEXT | no | default `'09:00'`, `CHECK (delivery_time GLOB '[0-2][0-9]:[0-5][0-9]')` |
| `reminder_interval_days` | INTEGER | no | default `7`, `CHECK (>= 1)` |
| `send_window_start` | TEXT | no | default `'08:00'` — late/catch-up sends are held outside this window |
| `send_window_end` | TEXT | no | default `'21:30'` |
| `catchup_gap_minutes` | INTEGER | no | default `120` — heartbeat gap that marks the previous period an outage |
| `catchup_digest_threshold` | INTEGER | no | default `3` — more than this many simultaneous catch-ups per recipient ⇒ one digest instead |
| `slot_grace_minutes` | INTEGER | no | default `30` — a slot later than this is "late", not "on time" |
| `action_ttl_days` | INTEGER | no | default `30` — max age of a notification nonce accepted from HA |
| `battery_threshold_pct` | INTEGER | no | default `15` (our own value; HA's `input_number.battery_alert_threshold` is read-only reference) |
| `battery_clear_pct` | INTEGER | no | default `30`, `CHECK (battery_clear_pct > battery_threshold_pct)` |
| `battery_sustain_minutes` | INTEGER | no | default `120` |
| `battery_clear_sustain_minutes` | INTEGER | no | default `360` |
| `battery_stale_hours` | INTEGER | no | default `48` |
| `reorder_horizon_days` | INTEGER | no | default `90` |
| `ha_base_url` | TEXT | no | `http://homeassistant.local:8123` |
| `current_model_id` | TEXT | no | `'example-house-1'` |
| `current_model_revision_id` | TEXT | yes | → `model_revision.id` |
| `inventory_push_enabled` | INTEGER | no | default `0` — inventory warnings are in-app only by default |
| `created_at_ms`, `updated_at_ms`, `updated_by` | INTEGER/TEXT | no/yes | audit |

**`user_notify_device`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `user_id` | TEXT | no | → `user.id` |
| `label` | TEXT | no | "Lucas iPhone" |
| `notify_service` | TEXT | no | `'notify.mobile_app_lucas_iphone'` |
| `ha_device_name` | TEXT | yes | for matching `mobile_app_notification_action` source fields |
| `is_active` | INTEGER | no | default 1 |
| `created_at_ms`, `created_by` | | | |

Unique: `(notify_service)`. Index: `(user_id, is_active)`.
Invariant (code): every user with any assignment must have ≥1 active device, else notifications for that user are recorded as `failed_no_device` and raise an `app_alert`.

**`audit_log`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `at_ms` | INTEGER | no | index |
| `actor_kind` | TEXT | no | `CHECK IN ('user','worker','system','ha')` |
| `actor_user_id` | TEXT | yes | → `user.id`; NOT NULL when `actor_kind='user'` (code) |
| `entity_table` | TEXT | no | |
| `entity_id` | TEXT | no | |
| `action` | TEXT | no | `'created'`,`'updated'`,`'completed'`,`'skipped'`,`'postponed'`,`'stock_adjusted'`,`'ha_link_repaired'`,`'model_reconciled'`,… |
| `summary` | TEXT | no | one human-readable line |
| `changes_json` | TEXT | yes | `{ field: [before, after] }`, only for `updated` |
| `request_id` | TEXT | yes | correlates web request / worker tick |

Indexes: `(entity_table, entity_id, at_ms)`, `(at_ms)`, `(actor_user_id, at_ms)`.

**Auditing recommendation (deliverable 1 asks for one): hybrid, and here is why.**
1. Every domain table carries `created_at_ms`, `created_by`, `updated_at_ms`, `updated_by` — cheap, always available for "who touched this last", and no join to render a list.
2. `audit_log` receives a row for *meaningful* changes only, written by the service layer: all occurrence state transitions, completions and voids, every `stock_transaction` reason that is not a plain consumption, plan schedule edits (with a field diff), HA link repairs, model reconciliation decisions, and household setting changes.
3. **Do not use SQLite triggers.** A trigger cannot see the actor (it is not in the DB), and the worker and web process would need to inject it via a temp table — fragile. The service layer knows the actor, and it is unit-testable.
4. Immutable ledgers (`stock_transaction`, `completion`, `delivery_attempt`, `occurrence_event`) are their own audit trail; `audit_log` does not duplicate their payload, only references them.

### 1.4 M1 — model & place

**`model_revision`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `model_id` | TEXT | no | `'example-house-1'` |
| `schema_version` | TEXT | no | from the package manifest |
| `generated_at_ms` | INTEGER | no | from the package |
| `content_hash` | TEXT | no | sha256 of the canonicalised geometry+id manifest |
| `coordinate_system_json` | TEXT | no | `{"units":"m","up":"y","forward":"-z","origin":"model-frame"}` — exported with every dataset |
| `node_count` | INTEGER | no | |
| `imported_at_ms` | INTEGER | no | |
| `imported_by` | TEXT | yes | → `user.id` |
| `status` | TEXT | no | `CHECK IN ('imported','current','superseded')` |

Unique: `(model_id, content_hash)`. Partial unique: `UNIQUE (model_id) WHERE status='current'`.

**`model_node`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | surrogate |
| `revision_id` | TEXT | no | → `model_revision.id` ON DELETE CASCADE |
| `node_id` | TEXT | no | semantic id from the package: `r-g-kitchen`, `f-ground`, `b-house` |
| `kind` | TEXT | no | `CHECK IN ('building','floor','room','zone','surface','element')` |
| `parent_node_id` | TEXT | yes | semantic id of parent within the same revision |
| `name` | TEXT | no | |
| `centroid_x/_y/_z` | REAL | yes | metres |
| `bbox_min_x/_y/_z`, `bbox_max_x/_y/_z` | REAL | yes | metres |
| `area_m2` | REAL | yes | |

Unique: `(revision_id, node_id)`. Indexes: `(revision_id, kind)`, `(revision_id, parent_node_id)`.

**`model_node_alias`** — decisions carried forward across imports.

`id` PK · `model_id` TEXT NOT NULL · `from_revision_id` → revision · `to_revision_id` → revision · `old_node_id` TEXT NOT NULL · `new_node_id` TEXT NULL (NULL = intentionally removed) · `decided_by` → user · `decided_at_ms` · `note` TEXT NULL.
Unique: `(model_id, from_revision_id, to_revision_id, old_node_id)`.

**`location`** — one self-referencing tree instead of four tables.

Why one table: every spatial record then needs a single `location_id` FK instead of a four-way polymorphic reference; the shape mirrors HA's floor/area model, which makes `location_mapping` trivial; and the tree is tiny (tens of rows).

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `kind` | TEXT | no | `CHECK IN ('property','building','floor','room','zone')` |
| `parent_id` | TEXT | yes | → `location.id`; `CHECK ((kind='property') = (parent_id IS NULL))` |
| `name` | TEXT | no | |
| `slug` | TEXT | no | stable app-side key, e.g. `ground-kitchen` |
| `sort_order` | INTEGER | no | default 0 |
| `floor_level` | INTEGER | yes | only for `kind='floor'` |
| `is_outdoor` | INTEGER | no | default 0; `CHECK (kind='zone' OR is_outdoor=0)` unless an outdoor room exists — keep as code invariant instead if garages/sheds are rooms |
| `model_revision_id` | TEXT | yes | → `model_revision.id` |
| `model_node_id` | TEXT | yes | e.g. `r-g-kitchen` |
| `needs_reconciliation` | INTEGER | no | default 0 |
| `notes` | TEXT | yes | |
| audit quad | | | |

Unique: `(slug)`; partial unique `(model_revision_id, model_node_id) WHERE model_node_id IS NOT NULL`.
Indexes: `(parent_id, sort_order)`, `(kind)`.
Code invariants: allowed parent kinds — `building→property`, `floor→building`, `room→floor`, `zone→property|building`; no cycles (validate on write by walking to root, depth ≤ 8).

**`location_mapping`** — HA area/floor ↔ our location.

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `ha_kind` | TEXT | no | `CHECK IN ('area','floor')` |
| `ha_id` | TEXT | no | HA `area_id` / `floor_id` |
| `location_id` | TEXT | no | → `location.id` |
| `source` | TEXT | no | `CHECK IN ('suggested','confirmed','rejected')` |
| `confidence` | REAL | yes | 0..1, only for `suggested` |
| `match_reason` | TEXT | yes | `'name_exact'`,`'name_fuzzy:0.86'`,`'manual'` |
| `decided_by`, `decided_at_ms` | | yes | |
| audit quad | | | |

Unique: `(ha_kind, ha_id)` — one mapping per HA area. Partial unique `(location_id) WHERE source='confirmed' AND ha_kind='area'` (one confirmed area per room; drop if a room legitimately maps to two HA areas).
Suggestion algorithm: normalise both names (lowercase, strip diacritics, strip `the`/`room`), exact match ⇒ confidence 1.0 auto-`suggested`; else trigram similarity ≥ 0.7 ⇒ `suggested`. Never auto-`confirmed`.

### 1.5 M2 — assets & systems

**`asset`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `name` | TEXT | no | "Master bedroom smoke alarm" |
| `category` | TEXT | no | `CHECK IN ('appliance','hvac','plumbing','electrical','network','safety','structure','outdoor','vehicle','software','other')` |
| `manufacturer`, `model_name`, `serial_number`, `product_code` | TEXT | yes | |
| `location_id` | TEXT | yes | → `location.id` (nullable: software assets, or spares in storage) |
| `parent_asset_id` | TEXT | yes | → `asset.id` — sub-components (compressor inside heat pump) |
| `is_virtual` | INTEGER | no | default 0 — HA software "devices" (e.g. an integration) |
| `status` | TEXT | no | `CHECK IN ('planned','installed','removed','retired','lost')` |
| `installed_on` | TEXT | yes | LocalDate |
| `installed_on_precision` | TEXT | yes | `CHECK IN ('exact','month','year','unknown')` |
| `removed_on` | TEXT | yes | LocalDate |
| `replaces_asset_id` | TEXT | yes | → `asset.id` (this unit replaced that one) |
| `replaced_by_asset_id` | TEXT | yes | → `asset.id` |
| `purchase_price_cents`, `currency` | INTEGER/TEXT | yes | |
| `warranty_until` | TEXT | yes | LocalDate |
| `expected_life_years` | INTEGER | yes | |
| `notes` | TEXT | yes | |
| audit quad | | | |

Indexes: `(location_id)`, `(status)`, `(category)`, `(parent_asset_id)`, `(replaced_by_asset_id)`.
Code invariants: `status='removed'|'retired'` ⇒ `removed_on` not null; `replaced_by_asset_id` not null ⇒ status in `('removed','retired')`; replacement chains must be acyclic; `replaces_asset_id` and `replaced_by_asset_id` must be mutually consistent (both sides written in one transaction).

**`asset_placement`** — where the asset sits in the 3D model. Separate from `asset` because a placement is revision-scoped and reconciliation-sensitive, and one asset may have a placement plus a "route entry point".

`id` PK · `asset_id` → asset CASCADE · `model_revision_id` → revision · `model_node_id` TEXT NOT NULL · `pos_x/_y/_z` REAL NULL · `rot_yaw_deg` REAL NULL · `placement_kind` TEXT `CHECK IN ('body','access_panel','label','shutoff')` DEFAULT `'body'` · `needs_reconciliation` INTEGER DEFAULT 0 · `color_override` TEXT NULL (`#rrggbb`) · audit quad.
Unique: `(asset_id, placement_kind)`. Index: `(model_revision_id, model_node_id)`.
**Hard rule:** placement writes are only accepted from an explicit "set placement" API call carrying `viewMode: 'normal'`. Requests with `viewMode` of `'exploded'` or `'cutaway'` are rejected with 422. Exploded/cutaway transforms live in client memory and the URL only; there is no table for them.

**`asset_consumable`** — what an asset eats.

`id` PK · `asset_id` → asset CASCADE · `part_id` → part · `role` TEXT `CHECK IN ('battery','filter','bag','belt','lamp','fluid','seal','other')` · `qty_milli` INTEGER NOT NULL `CHECK (> 0)` · `notes` TEXT.
Unique: `(asset_id, part_id, role)`.
Used to pre-fill completion material lines ("2 × AAA") and to compute upcoming demand for reorder suggestions.

**`asset_replacement`**

`id` PK · `old_asset_id` → asset · `new_asset_id` → asset · `occurrence_id` → occurrence NULL · `completion_id` → completion NULL · `replaced_on` TEXT NOT NULL (LocalDate) · `reason` TEXT `CHECK IN ('failure','end_of_life','upgrade','damage','recall','other')` · `notes` TEXT · audit quad.
Unique: `(old_asset_id, new_asset_id)`; unique `(old_asset_id)` (a unit is replaced once).

**`system`** · `id` PK · `name` · `kind` TEXT `CHECK IN ('ventilation','water','wastewater','heating','electrical','networking','security','irrigation','other')` · `description` · `status` `CHECK IN ('active','decommissioned')` · audit quad.
**`system_asset`** · `system_id`, `asset_id`, `role` TEXT NULL — PK `(system_id, asset_id)`.
**`system_location`** · `system_id`, `location_id` — PK `(system_id, location_id)`. This is how a system spans locations without inventing a location hierarchy hack.

**`asset_ha_link`** — the robust link (details and rename handling in §7).

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `asset_id` | TEXT | no | → `asset.id` ON DELETE CASCADE |
| `link_kind` | TEXT | no | `CHECK IN ('device','entity')` |
| `ha_device_id` | TEXT | yes | → `ha_device.device_id` ON DELETE SET NULL |
| `ha_entity_registry_id` | TEXT | yes | → `ha_entity.registry_id` ON DELETE SET NULL |
| `role` | TEXT | no | `CHECK IN ('primary','battery_level','power','status','control','diagnostic','other')` |
| `entity_id_snapshot` | TEXT | yes | last-known `entity_id` (renameable, informational) |
| `unique_id_snapshot` | TEXT | yes | HA integration `unique_id` |
| `platform_snapshot` | TEXT | yes | HA platform/integration domain |
| `link_state` | TEXT | no | `CHECK IN ('active','renamed','missing','replaced','retired')` |
| `link_state_changed_at_ms` | INTEGER | yes | |
| `notes` | TEXT | yes | |
| audit quad | | | |

`CHECK ((link_kind='device') = (ha_device_id IS NOT NULL AND ha_entity_registry_id IS NULL))`.
Unique: `(asset_id, link_kind, ha_device_id, ha_entity_registry_id)`; partial unique `(asset_id, role) WHERE role IN ('primary','battery_level')`.
Indexes: `(ha_entity_registry_id)`, `(ha_device_id)`, `(link_state)`.

### 1.6 M3 — procedures

**`procedure`** · `id` PK · `title` · `slug` UNIQUE · `summary` · `default_effort_minutes` INTEGER NULL · `current_version_id` TEXT NULL → `procedure_version.id` · `archived_at_ms` NULL · audit quad.

**`procedure_version`** · `id` PK · `procedure_id` → procedure CASCADE · `version` INTEGER NOT NULL · `status` `CHECK IN ('draft','published','superseded')` · `published_at_ms` NULL · `published_by` NULL · `change_note` TEXT NULL · `safety_notes` TEXT NULL · `prerequisites` TEXT NULL · audit quad.
Unique: `(procedure_id, version)`. Partial unique `(procedure_id) WHERE status='draft'` — at most one draft at a time.
**Immutability:** once `status='published'`, the version row and all its children are read-only in the service layer (any edit forks a new draft). Enforced in code + tested.

**`procedure_step`** · `id` PK · `version_id` → procedure_version CASCADE · `seq` INTEGER NOT NULL · `title` · `body_md` TEXT · `expected_minutes` INTEGER NULL · `is_optional` INTEGER DEFAULT 0 · `warning` TEXT NULL.
Unique: `(version_id, seq)`.

**`procedure_checklist_item`** · `id` PK · `version_id` → CASCADE · `step_id` TEXT NULL → procedure_step · `seq` INTEGER · `text` TEXT · `requires_value` TEXT NULL `CHECK IN (NULL,'number','text','photo')` · `unit` TEXT NULL.
Unique: `(version_id, step_id, seq)` (with `step_id` NULL meaning version-level).

**`procedure_tool`** · `id` PK · `version_id` → CASCADE · `name` · `is_required` INTEGER DEFAULT 1 · `notes`.
**`procedure_material`** · `id` PK · `version_id` → CASCADE · `part_id` → part · `qty_milli` INTEGER `CHECK (>0)` · `is_required` INTEGER DEFAULT 1 · `notes`. Unique `(version_id, part_id)`.
**`procedure_reference`** · `id` PK · `version_id` → CASCADE · `kind` `CHECK IN ('manual','page','url','video','datasheet')` · `label` · `url` TEXT NULL · `manual_name` TEXT NULL · `page_from` INTEGER NULL · `page_to` INTEGER NULL · `attachment_id` TEXT NULL → attachment.
**`procedure_equipment_note`** · `id` PK · `version_id` → CASCADE · `asset_id` TEXT NULL → asset · `asset_model_name` TEXT NULL · `note` TEXT NOT NULL — "on the 2019 model the filter clip is reversed".

### 1.7 M4 — maintenance

**`maintenance_plan`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `title` | TEXT | no | |
| `description` | TEXT | yes | |
| `asset_id` | TEXT | yes | → `asset.id` |
| `system_id` | TEXT | yes | → `system.id` |
| `location_id` | TEXT | yes | → `location.id` |
| `procedure_id` | TEXT | yes | → `procedure.id` |
| `pin_procedure_version_id` | TEXT | yes | → `procedure_version.id`; NULL = use current published |
| `schedule_kind` | TEXT | no | `CHECK IN ('interval_from_completion','fixed_calendar','seasonal_window','one_off','condition')` |
| `recurrence_json` | TEXT | no | the rule (§2); `'{"v":1,"kind":"one_off"}'` for one-offs |
| `schedule_anchor_date` | TEXT | yes | LocalDate — the input to `computeNextDue`. **Not** a claim that work happened. |
| `schedule_anchor_source` | TEXT | no | `CHECK IN ('completion','baseline_exact','baseline_approx','user_chosen','skipped_due_date','install_date','none')` |
| `schedule_anchor_note` | TEXT | yes | "owner says roughly spring 2024" |
| `last_completion_id` | TEXT | yes | → `completion.id` — the *factual* history pointer |
| `assignment_mode` | TEXT | no | `CHECK IN ('user','shared')` |
| `assignee_user_id` | TEXT | yes | → `user.id`; `CHECK ((assignment_mode='user') = (assignee_user_id IS NOT NULL))` |
| `priority` | TEXT | no | `CHECK IN ('low','normal','high','urgent')` default `'normal'` |
| `estimated_minutes` | INTEGER | yes | |
| `requires_professional` | INTEGER | no | default 0 |
| `default_provider_id` | TEXT | yes | → `service_provider.id` |
| `status` | TEXT | no | `CHECK IN ('active','paused','cancelled')` |
| `cancelled_at_ms`, `cancel_reason` | | yes | |
| `allow_quick_done` | INTEGER | no | default computed — see §4.6; cached, recomputed on plan/procedure/material change |
| audit quad | | | |

`CHECK ((asset_id IS NOT NULL) + (system_id IS NOT NULL) + (location_id IS NOT NULL) = 1)`.
Indexes: `(status)`, `(asset_id)`, `(system_id)`, `(schedule_kind)`, `(assignee_user_id)`.

**`plan_material`** · `id` PK · `plan_id` → plan CASCADE · `part_id` → part · `qty_milli` INTEGER `CHECK (>0)` · `is_required` INTEGER DEFAULT 1 · `notes`. Unique `(plan_id, part_id)`.
Resolution order for a completion's expected materials: `plan_material` ∪ `procedure_material` (plan wins on conflicting `part_id`) ∪ `asset_consumable` for roles the procedure declares.

**`maintenance_occurrence`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `plan_id` | TEXT | yes | → `maintenance_plan.id`; NULL for ad-hoc |
| `source` | TEXT | no | `CHECK IN ('plan','manual','condition')` |
| `condition_episode_id` | TEXT | yes | → `condition_episode.id` |
| `asset_id`, `system_id`, `location_id` | TEXT | yes | snapshot of target at generation |
| `title` | TEXT | no | snapshot |
| `procedure_version_id` | TEXT | yes | resolved at generation; frozen for the occurrence |
| `status` | TEXT | no | `CHECK IN ('pending','due','completed','skipped','cancelled')` |
| `due_date` | TEXT | no | LocalDate |
| `original_due_date` | TEXT | no | LocalDate — never changes; the honest record |
| `window_start_date`, `window_end_date` | TEXT | yes | seasonal windows |
| `generation_note_json` | TEXT | yes | `{"missedSeriesDates":["2026-10-01"],"anchorSource":"completion"}` |
| `assignment_mode` | TEXT | no | snapshot; `CHECK IN ('user','shared')` |
| `assignee_user_id` | TEXT | yes | snapshot |
| `priority` | TEXT | no | snapshot |
| `estimated_minutes` | INTEGER | yes | snapshot |
| `blocked_reason` | TEXT | yes | non-NULL ⇒ blocked |
| `blocked_at_ms`, `blocked_by` | | yes | |
| `service_booking_id` | TEXT | yes | → `service_booking.id`; non-NULL ⇒ booked |
| `became_due_at_ms` | INTEGER | yes | set on `pending→due` |
| `completion_id` | TEXT | yes | → `completion.id` |
| `closed_at_ms` | INTEGER | yes | set on any terminal transition |
| `close_reason` | TEXT | yes | |
| audit quad | | | |

**Indexes and the load-bearing invariant:**

```sql
-- one open occurrence per recurring plan, ever
CREATE UNIQUE INDEX ux_occ_open_per_plan
  ON maintenance_occurrence(plan_id)
  WHERE plan_id IS NOT NULL AND status IN ('pending','due');

-- one open condition-derived occurrence per (rule, asset)
CREATE UNIQUE INDEX ux_occ_open_per_condition
  ON maintenance_occurrence(condition_rule_key)   -- generated col: rule_id||':'||asset_id
  WHERE source='condition' AND status IN ('pending','due');

CREATE INDEX ix_occ_status_due ON maintenance_occurrence(status, due_date);
CREATE INDEX ix_occ_asset      ON maintenance_occurrence(asset_id, status);
CREATE INDEX ix_occ_assignee   ON maintenance_occurrence(assignee_user_id, status, due_date);
```

(`condition_rule_key` is a `GENERATED ALWAYS AS (condition_rule_id || ':' || coalesce(asset_id,'')) VIRTUAL` column so the partial unique index can be composite-with-predicate.)

Checks: `CHECK ((status IN ('completed')) = (completion_id IS NOT NULL))`, `CHECK ((status IN ('completed','skipped','cancelled')) = (closed_at_ms IS NOT NULL))`, `CHECK (window_end_date IS NULL OR window_start_date IS NOT NULL)`.

**`occurrence_progress_item`** — resumable guided procedure.

`id` PK · `occurrence_id` → occurrence CASCADE · `item_kind` TEXT `CHECK IN ('step','checklist')` · `step_id` TEXT NULL → procedure_step · `checklist_item_id` TEXT NULL → procedure_checklist_item · `state` TEXT `CHECK IN ('todo','in_progress','done','skipped')` DEFAULT `'todo'` · `value_text` TEXT NULL · `value_number` REAL NULL · `attachment_id` TEXT NULL · `changed_at_ms` · `changed_by`.
Unique: `(occurrence_id, item_kind, step_id, checklist_item_id)`.
Progress rows are created lazily on first interaction (not up front), survive navigation away and process restart, and are **retained** after completion as part of the record. Resuming = read all rows for the occurrence and jump to the lowest `seq` step that is not `done`/`skipped`.

**`occurrence_event`** — typed domain timeline (drives the UI; `audit_log` stays generic).

`id` PK · `occurrence_id` → occurrence CASCADE · `at_ms` · `actor_kind` · `actor_user_id` NULL · `kind` TEXT `CHECK IN ('created','became_due','completed','completion_voided','postponed','snoozed','skipped','cancelled','blocked','unblocked','booked','booking_cancelled','reopened','notified','condition_recovered','materials_reconciled')` · `from_status` NULL · `to_status` NULL · `from_due_date` NULL · `to_due_date` NULL · `reason` TEXT NULL · `detail_json` TEXT NULL.
Index: `(occurrence_id, at_ms)`.

**`completion`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `request_id` | TEXT | no | **UNIQUE** — client-generated `completionRequestId` (idempotency key) |
| `occurrence_id` | TEXT | no | → `maintenance_occurrence.id` |
| `plan_id` | TEXT | yes | snapshot |
| `asset_id` | TEXT | yes | **snapshot** — history stays on the unit serviced, survives replacement |
| `procedure_version_id` | TEXT | yes | snapshot |
| `completed_at_ms` | INTEGER | no | may be in the past |
| `completed_local_date` | TEXT | no | LocalDate in household tz — the scheduling anchor |
| `completed_at_precision` | TEXT | no | `CHECK IN ('exact','day','month')` default `'exact'` |
| `performed_by_user_id` | TEXT | yes | → user; NULL when a professional did it |
| `performed_by_provider_id` | TEXT | yes | → `service_provider.id` |
| `recorded_by` | TEXT | no | → user (who typed it in) |
| `notes` | TEXT | yes | |
| `effort_minutes` | INTEGER | yes | |
| `outcome` | TEXT | no | `CHECK IN ('done','done_with_issues','partial')` default `'done'` |
| `stock_resolution` | TEXT | no | `CHECK IN ('none','sufficient','adjusted_up','consumed_available','discrepancy_noted')` |
| `is_replacement` | INTEGER | no | default 0 |
| `voided_at_ms`, `voided_by`, `void_reason` | | yes | |
| `source` | TEXT | no | `CHECK IN ('web','notification_action','import')` |
| audit quad | | | |

Unique: `(request_id)`. Partial unique `(occurrence_id) WHERE voided_at_ms IS NULL` — at most one live completion per occurrence.
`CHECK (performed_by_user_id IS NOT NULL OR performed_by_provider_id IS NOT NULL)`.
Indexes: `(occurrence_id)`, `(asset_id, completed_local_date)`, `(plan_id, completed_local_date)`.

**`completion_material`** · `id` PK · `completion_id` → completion CASCADE · `part_id` → part · `lot_id` TEXT NULL → part_lot · `expected_qty_milli` INTEGER NULL · `actual_qty_milli` INTEGER NOT NULL `CHECK (>= 0)` · `shortfall_milli` INTEGER NOT NULL DEFAULT 0 `CHECK (>= 0)` · `resolution` TEXT `CHECK IN ('sufficient','adjusted_up','consumed_available','discrepancy_noted')` · `stock_transaction_id` TEXT NULL → stock_transaction · `notes`.
Unique: `(completion_id, part_id, lot_id)`.

**`service_provider`** · `id` PK · `name` · `trade` TEXT (`'plumbing'`,`'hvac'`,`'electrical'`,`'chimney'`,…) · `contact_name`, `phone`, `email`, `website`, `address` · `vat_id` · `notes` · `is_preferred` INTEGER DEFAULT 0 · audit quad.

**`service_booking`** — booking ≠ completion, so it is its own record with its own status.

`id` PK · `occurrence_id` TEXT NULL → occurrence · `provider_id` → provider · `status` TEXT `CHECK IN ('requested','confirmed','rescheduled','cancelled','attended','no_show')` · `requested_at_ms` · `scheduled_start_ms` NULL · `scheduled_end_ms` NULL · `scheduled_local_date` TEXT NULL · `window_note` TEXT NULL ("between 8 and 12") · `reference` TEXT NULL (provider's booking ref) · `quoted_price_cents` NULL · `contact_note` TEXT · audit quad.
Index: `(occurrence_id)`, `(scheduled_start_ms)`.
**Invariant:** creating or confirming a booking never sets `occurrence.status='completed'`. Attendance (`status='attended'`) also does not complete; a `completion` row is still required.

**`service_document`** · `id` PK · `kind` TEXT `CHECK IN ('quote','invoice','receipt','certificate','report','warranty')` · `provider_id` NULL · `booking_id` NULL · `completion_id` NULL · `asset_id` NULL · `document_no` TEXT · `issued_on` TEXT (LocalDate) · `valid_until` TEXT NULL · `amount_cents` NULL · `currency` · `attachment_id` TEXT NULL → attachment · `notes` · audit quad.
`CHECK (booking_id IS NOT NULL OR completion_id IS NOT NULL OR asset_id IS NOT NULL)`.

### 1.8 M5 — inventory

**`part`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `name` | TEXT | no | "HEPA filter F7 / 200×200" |
| `spec` | TEXT | yes | free text spec/dimensions |
| `dimensions` | TEXT | yes | "200×200×46 mm" |
| `manufacturer`, `product_code`, `ean` | TEXT | yes | |
| `tracking_mode` | TEXT | no | `CHECK IN ('discrete','measured','estimated')` |
| `unit` | TEXT | no | `'pcs'`,`'l'`,`'ml'`,`'m'`,`'kg'`,`'g'` |
| `is_kit` | INTEGER | no | default 0 |
| `stock_mode` | TEXT | no | `CHECK IN ('stocked','not_stocked')` — see kit rule below |
| `reorder_threshold_milli` | INTEGER | yes | |
| `reorder_target_milli` | INTEGER | yes | |
| `lead_time_days` | INTEGER | yes | |
| `default_storage_place_id` | TEXT | yes | → `storage_place.id` |
| `tracks_lots` | INTEGER | no | default 0 — enable for parts with expiry |
| `notes` | TEXT | yes | |
| `archived_at_ms` | INTEGER | yes | |
| audit quad | | | |

Unique: partial `(manufacturer, product_code) WHERE product_code IS NOT NULL`.
`CHECK (tracking_mode='discrete' OR unit <> 'pcs')` is too strong — instead code invariant: `discrete` ⇒ all `qty_milli` are multiples of 1000.

**Kits vs component parts — the chosen representation, and why it cannot double count.**

Rules:
1. A kit is an ordinary `part` with `is_kit = 1` and rows in `kit_component (kit_part_id, component_part_id, qty_milli)`.
2. **Stock is tracked only where the goods physically sit.** Exactly one of the kit or its components is `stock_mode='stocked'` for a given physical holding, and the app never derives availability across the boundary. `available(part) = SUM(stock_transaction.qty_milli WHERE part_id = part)` — full stop. There is no `+ kits × ratio` term anywhere.
3. Breaking a kit open is an explicit, audited operation: a **kit explode** writes, in one transaction, one consumption of the kit (`-1000`) plus one addition per component (`+qty_milli`), all sharing a `transaction_group_id` and `reason='kit_explode'`. After the explode, the components have stock and the kit does not. Reversible by a single "undo explode" that writes the mirror-image group.
4. `kit_component` is therefore *bill-of-materials metadata* used for two things only: (a) telling the user "you have 1 unopened kit which contains the 2 filters you need — explode it?"; (b) compatibility inference (a component is compatible with whatever the kit is compatible with).
5. `CHECK (is_kit = 1 OR stock_mode = 'stocked')` — non-kit parts are always stocked. A `not_stocked` kit is a pure BOM definition (a "kit" you never buy as a box).

This is deliberately duller than a BOM-explosion availability engine. It costs one extra user click when opening a box and makes "how many filters do I have" a single `SUM`.

**`kit_component`** · `kit_part_id` → part · `component_part_id` → part · `qty_milli` INTEGER `CHECK (>0)` · PK `(kit_part_id, component_part_id)` · `CHECK (kit_part_id <> component_part_id)`. Code invariant: no cycles (depth ≤ 3).

**`part_compatibility`** · `id` PK · `part_id` → part · `asset_id` TEXT NULL → asset · `asset_model_name` TEXT NULL · `manufacturer` TEXT NULL · `confidence` TEXT `CHECK IN ('confirmed','likely','unverified')` · `note`.
`CHECK (asset_id IS NOT NULL OR asset_model_name IS NOT NULL)`. Unique partial `(part_id, asset_id) WHERE asset_id IS NOT NULL`.

**`part_supplier`** · `id` PK · `part_id` → part CASCADE · `supplier_name` · `supplier_sku` · `url` · `last_price_cents` NULL · `currency` · `pack_qty_milli` NULL · `lead_time_days` NULL · `is_preferred` INTEGER DEFAULT 0 · `note`.
Unique partial `(part_id) WHERE is_preferred=1`.

**`storage_place`** · `id` PK · `name` ("Garage shelf B, bin 3") · `location_id` → location · `model_node_id` TEXT NULL · `parent_place_id` TEXT NULL → storage_place · `notes` · audit quad. Unique `(location_id, name)`.

**`part_lot`** — optional; only for `part.tracks_lots=1`.
`id` PK · `part_id` → part · `label` TEXT · `storage_place_id` NULL → storage_place · `purchased_on` TEXT NULL · `expires_on` TEXT NULL · `opened_on` TEXT NULL · `initial_qty_milli` INTEGER NULL · `is_open` INTEGER DEFAULT 0 · `estimate_pct` INTEGER NULL `CHECK (estimate_pct BETWEEN 0 AND 100)` — the "estimated remaining for liquids" dial · `notes` · audit quad.
Unique `(part_id, label)`. Index `(part_id, expires_on)`.
For `tracking_mode='estimated'`, the authoritative number is `estimate_pct` on the open lot; stock transactions still exist but are informational (`reason='estimate_update'` writes the delta implied by the new percentage so the ledger stays the single source of the number).

**`stock_transaction`** — append-only ledger. **Never updated, never deleted.**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `part_id` | TEXT | no | → `part.id` |
| `lot_id` | TEXT | yes | → `part_lot.id` |
| `storage_place_id` | TEXT | yes | → `storage_place.id` |
| `qty_milli` | INTEGER | no | **signed**; `CHECK (qty_milli <> 0)` |
| `kind` | TEXT | no | `CHECK IN ('purchase','consumption','adjustment','correction','kit_explode_in','kit_explode_out','estimate_update','initial_count','disposal')` |
| `reason` | TEXT | no | `CHECK IN ('purchase','maintenance_consumption','stock_take','reconcile_missing_stock','reconcile_surplus','completion_voided','kit_explode','kit_explode_undo','expired','damaged','estimate_update','manual_correction','initial_seed')` |
| `occurrence_id` | TEXT | yes | → occurrence |
| `completion_id` | TEXT | yes | → completion |
| `transaction_group_id` | TEXT | yes | ties a multi-row atomic operation together |
| `reverses_transaction_id` | TEXT | yes | → `stock_transaction.id` UNIQUE — a txn can be reversed once |
| `unit_price_cents` | INTEGER | yes | |
| `occurred_at_ms` | INTEGER | no | when it physically happened (may be backdated) |
| `occurred_local_date` | TEXT | no | |
| `notes` | TEXT | yes | |
| `created_at_ms`, `created_by` | | no/yes | recorded-at, actor |

Unique: `(reverses_transaction_id)`. Indexes: `(part_id, occurred_at_ms)`, `(completion_id)`, `(transaction_group_id)`, `(lot_id)`.
Checks: `CHECK (kind <> 'consumption' OR qty_milli < 0)`, `CHECK (kind NOT IN ('purchase','initial_count','kit_explode_in') OR qty_milli > 0)`.
**Negative balances are allowed** — that is how `discrepancy_noted` is represented honestly. The UI shows negative stock in red with a "reconcile" call to action.

**`part_stock`** — SQL view (no cache table, no drift):

```sql
CREATE VIEW part_stock AS
SELECT p.id AS part_id,
       COALESCE(SUM(t.qty_milli), 0)                                     AS on_hand_milli,
       COALESCE(SUM(CASE WHEN t.occurred_at_ms <= unixepoch()*1000
                         THEN t.qty_milli END), 0)                       AS effective_milli,
       MAX(t.occurred_at_ms)                                             AS last_movement_ms
FROM part p LEFT JOIN stock_transaction t ON t.part_id = p.id
GROUP BY p.id;
```

Data volume is small (hundreds to low thousands of rows); `SUM` with the `(part_id, occurred_at_ms)` index is microseconds. Revisit only if a part exceeds ~50k transactions.

**`app_alert`** — in-app warnings (inventory low, HA link broken, stale battery reading, model needs reconciliation). Not push unless `household_setting.inventory_push_enabled`/per-kind override says so.
`id` PK · `kind` TEXT `CHECK IN ('low_stock','negative_stock','expiring_part','ha_link_missing','ha_entity_renamed','stale_sensor','model_reconciliation','notify_device_missing','worker_outage')` · `severity` `CHECK IN ('info','warning','error')` · `entity_table`, `entity_id` · `title`, `body` · `dedupe_key` TEXT NOT NULL · `first_seen_at_ms`, `last_seen_at_ms`, `seen_count` INTEGER · `acknowledged_at_ms` NULL, `acknowledged_by` NULL · `resolved_at_ms` NULL.
Partial unique `(dedupe_key) WHERE resolved_at_ms IS NULL` — re-raising bumps `last_seen_at_ms`/`seen_count` rather than creating noise.

### 1.9 M6 — infrastructure & projects

**`infra_route`** · `id` PK · `name` · `system_id` NULL → system · `medium` TEXT `CHECK IN ('cold_water','hot_water','waste','supply_air','extract_air','electricity','ethernet','fiber','coax','gas','heating_water','drain')` · `nominal_size` TEXT NULL ("DN20", "Cat6a") · `from_endpoint_id` NULL → infra_endpoint · `to_endpoint_id` NULL → infra_endpoint · `model_revision_id` → revision · `is_estimated` INTEGER DEFAULT 1 (routes are usually inferred, be honest) · `notes` · `needs_reconciliation` INTEGER DEFAULT 0 · audit quad.
**`infra_route_point`** · `id` PK · `route_id` → CASCADE · `seq` INTEGER · `pos_x/_y/_z` REAL NOT NULL · `model_node_id` TEXT NULL · `point_kind` TEXT `CHECK IN ('vertex','junction','valve','outlet','penetration')` DEFAULT `'vertex'` · `asset_id` TEXT NULL → asset. Unique `(route_id, seq)`.
**`infra_endpoint`** · `id` PK · `name` · `kind` TEXT `CHECK IN ('source','terminal','junction','meter','shutoff','panel','patch_port')` · `location_id` NULL → location · `asset_id` NULL → asset · `model_revision_id` NULL · `model_node_id` NULL · `pos_x/_y/_z` REAL NULL · `notes` · audit quad.
**`annotation`** · `id` PK · `target_kind` TEXT `CHECK IN ('location','asset','route','node')` · `target_id` TEXT NULL · `model_revision_id` → revision · `model_node_id` TEXT NULL · `pos_x/_y/_z` REAL NULL · `kind` TEXT `CHECK IN ('note','measurement','warning','todo','photo_point')` · `title`, `body` · `measurement_value` REAL NULL · `measurement_unit` TEXT NULL · `needs_reconciliation` INTEGER DEFAULT 0 · audit quad.
**`project`** · `id` PK · `name` · `kind` TEXT `CHECK IN ('renovation','repair','installation','inspection','improvement')` · `status` `CHECK IN ('idea','planned','in_progress','done','abandoned')` · `started_on`, `ended_on` TEXT NULL · `budget_cents`, `actual_cost_cents` NULL · `currency` · `summary`, `notes` · audit quad.
**`project_link`** · `id` PK · `project_id` → project CASCADE · `entity_kind` TEXT `CHECK IN ('asset','location','system','occurrence','completion','service_document','part','infra_route')` · `entity_id` TEXT NOT NULL · `role` TEXT NULL. Unique `(project_id, entity_kind, entity_id)`.
Polymorphic FKs cannot be declared in SQLite; the service layer validates existence on insert and a nightly integrity job reports dangling links into `app_alert`. Accepted trade-off vs. eight nullable columns.

### 1.10 M9 — attachments & exports

**`attachment`** · `id` PK · `kind` TEXT `CHECK IN ('photo','pdf','manual','video','other')` · `mime` TEXT · `byte_size` INTEGER · `sha256` TEXT UNIQUE · `storage_path` TEXT NOT NULL (relative to a configured data dir; files on disk, **not** blobs in SQLite) · `original_filename` · `width`, `height` INTEGER NULL · `taken_at_ms` NULL · `caption` TEXT NULL · audit quad.
**`attachment_link`** · `id` PK · `attachment_id` → attachment CASCADE · `entity_kind` TEXT `CHECK IN ('asset','location','occurrence','completion','procedure_version','procedure_step','part','part_lot','annotation','service_document','project','infra_route')` · `entity_id` TEXT NOT NULL · `role` TEXT NULL (`'before'`,`'after'`,`'nameplate'`,`'receipt'`) · `seq` INTEGER DEFAULT 0. Unique `(attachment_id, entity_kind, entity_id, role)`.
**`export_run`** · `id` PK · `requested_by` → user · `format` `CHECK IN ('json','csv')` · `datasets_json` TEXT · `started_at_ms`, `finished_at_ms` NULL · `status` `CHECK IN ('running','done','failed')` · `output_path` TEXT NULL · `row_counts_json` TEXT NULL · `error` TEXT NULL.

---

## 2. Recurrence rules and `computeNextDue`

### 2.1 Stored JSON shape

Stored in `maintenance_plan.recurrence_json` as a compact discriminated union with an explicit version.

```ts
export type LocalDate = string & { __brand: 'LocalDate' };   // 'YYYY-MM-DD'
export type MonthDay  = { month: number; day: number | 'last' }; // month 1..12

export type RecurrenceRule =
  | { v: 1; kind: 'one_off' }

  /** (a) "6 months after the actual completion" */
  | { v: 1; kind: 'interval_from_completion';
      every: number;                       // >= 1
      unit: 'day' | 'week' | 'month' | 'year';
      /** month/year units: how to handle a day-of-month that does not exist */
      clamp?: 'end_of_month';              // default & only mode
    }

  /** (b1) "every April and October, on the 1st" / "every 1st of month" */
  | { v: 1; kind: 'fixed_monthly';
      months: number[];                    // 1..12, sorted, non-empty; [1..12] = every month
      dayOfMonth: number | 'last';         // 1..31 or 'last'
    }

  /** (b2) "every year on 15 November" */
  | { v: 1; kind: 'fixed_yearly'; month: number; day: number | 'last' }

  /** (b3) calendar-anchored interval that must not drift: "every 3 months from 2026-01-31" */
  | { v: 1; kind: 'fixed_interval';
      anchorDate: LocalDate;
      every: number;
      unit: 'day' | 'week' | 'month' | 'year';
    }

  /** (b4) "every Saturday", "every other Monday" */
  | { v: 1; kind: 'fixed_weekly';
      weekdays: number[];                  // 1=Mon .. 7=Sun (ISO)
      everyNWeeks?: number;                // default 1
      anchorDate?: LocalDate;              // required when everyNWeeks > 1 (parity origin)
    }

  /** (c) "between 1 May and 30 June, once per year" */
  | { v: 1; kind: 'seasonal_window';
      windowStart: MonthDay;
      windowEnd: MonthDay;                 // may be < windowStart => window spans New Year
      dueOn: 'window_start' | 'window_end' | { afterStartDays: number };
      timesPerYear: 1;                     // only 1 is supported; explicit for future-proofing
    }

  /** condition-driven plans carry no calendar rule */
  | { v: 1; kind: 'condition' };
```

Validation (Zod schema `recurrenceRuleSchema`, run on every plan write, plus a migration-time sweep):
`every >= 1`; `months` non-empty, unique, 1..12; `dayOfMonth` 1..31 or `'last'`; `weekdays` non-empty, unique, 1..7; `everyNWeeks > 1 ⇒ anchorDate` present; `seasonal_window` months/days are a real month/day pair (`{month:2,day:30}` rejected; `{month:2,day:'last'}` accepted).

### 2.2 Signature and semantics

```ts
export type AnchorSource =
  | 'completion' | 'baseline_exact' | 'baseline_approx' | 'user_chosen'
  | 'skipped_due_date' | 'install_date' | 'none';

export interface Anchor {
  /** Completion-anchored kinds: the completion's local date.
   *  Calendar kinds: the DUE DATE of the occurrence just closed (never the completion date). */
  date: LocalDate | null;
  source: AnchorSource;
}

export interface NextDue {
  dueDate: LocalDate;
  windowStartDate?: LocalDate;
  windowEndDate?: LocalDate;
  /** calendar dates in the series that fell entirely in the past and were rolled over */
  missedSeriesDates: LocalDate[];
}

export function computeNextDue(
  rule: RecurrenceRule,
  anchor: Anchor,
  now: Instant,
  tz: string,
): NextDue | null;   // null = no further occurrence (one_off, condition)
```

`today = localDateOf(now, tz)` throughout. The function is **pure** apart from `now`, which is injected — every test uses a fake clock.

### 2.3 Per-kind algorithm

**`one_off` / `condition`** → return `null`.

**`interval_from_completion`**

```
base = anchor.date            // required; if null -> throw ProgrammerError
cand = addUnit(base, every, unit)        // month/year use addMonthsClamped
return { dueDate: cand, missedSeriesDates: [] }
```

- `addMonthsClamped(d, n)`: take `(y, m, day)`, advance `m` by `n`, then `day' = min(day, lastDayOfMonth(y', m'))`.
- **No rolling forward.** If the anchor is far in the past (a completion backdated two years, or a very late completion of a short interval), the computed due date is in the past and the new occurrence is immediately overdue. That is the truth and the user should see it. Rolling forward would silently hide a missed cycle.
- Early completion legitimately shifts the whole cycle earlier — that is what "interval from actual completion" means. (A `keep_due_series` variant is deliberately *not* implemented; if it is ever wanted, model it as `fixed_interval`.)

**`fixed_monthly`, `fixed_yearly`, `fixed_interval`, `fixed_weekly`** — one shared helper, so the drift/skip behaviour is identical:

```
ref = anchor.date ?? today                 // exclusive lower bound
cand = firstSeriesDateStrictlyAfter(rule, ref)
missed = []
while (cand < today) { missed.push(cand); cand = firstSeriesDateStrictlyAfter(rule, cand) }
return { dueDate: cand, missedSeriesDates: missed }
```

Notes:
- The reference is the **previous due date**, not the completion date. Completing April's task on 20 April still yields 1 October, and completing it on 2 May also yields 1 October. No drift, ever.
- `cand < today` (strict): a series date landing on today stays today's due date.
- `missedSeriesDates` is written into `occurrence.generation_note_json` and an `audit_log` row `fixed_series_dates_skipped`. The app never fabricates completions for them; the UI shows "1 scheduled date passed while this task was open (2026-10-01)".
- `firstSeriesDateStrictlyAfter`:
  - `fixed_monthly`: iterate candidate `(year, month)` pairs in the rule's `months` ascending from `ref`'s year; materialise `day = dayOfMonth === 'last' ? lastDayOfMonth(y,m) : min(dayOfMonth, lastDayOfMonth(y,m))`; return the first > `ref`.
  - `fixed_yearly`: same with a single month.
  - `fixed_interval`: `k = ceil(monthsOrDaysBetween(anchorDate, ref)/every)`, then increment `k` until `dateAt(k) > ref`, where `dateAt(k) = addUnit(anchorDate, every*k, unit)` **computed from `anchorDate` each time** (never iteratively from the previous candidate). This is what kills the 31 → 28 → 28 drift bug.
  - `fixed_weekly`: next date after `ref` whose ISO weekday ∈ `weekdays` and, when `everyNWeeks > 1`, whose ISO-week distance from `anchorDate`'s week is ≡ 0 mod `everyNWeeks`.

**`seasonal_window`**

```
ref  = anchor.date ?? addDaysLocal(today, -1)
for (y = year(ref) - 1; y <= year(today) + 2; y++) {
  start = materialise(windowStart, y)
  end   = materialise(windowEnd, spansNewYear ? y + 1 : y)   // spansNewYear = (windowEnd < windowStart as month/day)
  due   = dueOn === 'window_start' ? start
        : dueOn === 'window_end'   ? end
        : addDaysLocal(start, dueOn.afterStartDays)
  if (start > ref) { candidates.push({ start, end, due }) }
}
pick the first candidate; roll forward (recording missed) while candidate.end < today
```

- The window "belongs to" the year of its **start**, which makes the Nov→Feb case unambiguous.
- Rolling uses `end < today`, not `due < today`: an occurrence whose window is still open should be created as due-now, not skipped.
- The generated occurrence carries `window_start_date` and `window_end_date`. Reminders use `due_date` exactly like any other occurrence (binding policy 1/3 unchanged). After `window_end_date` the occurrence stays open with a "window closed" badge; completing it late still satisfies that year and the next occurrence is the following year's window.

### 2.4 Seeding the first occurrence ("never fabricate history")

The critical structural decision: **`plan.schedule_anchor_date` (a scheduling input) is separate from `plan.last_completion_id` (a historical fact).** Seeding writes the former and leaves the latter NULL. No `completion` row is ever created by setup.

| Setup answer | `schedule_anchor_source` | `schedule_anchor_date` | First `due_date` | UI treatment |
|---|---|---|---|---|
| "Last done on 2026-03-14, I'm sure" | `baseline_exact` | `2026-03-14` | `computeNextDue(...)` from that anchor | "Next due computed from a recorded baseline (not a logged completion)" |
| "Sometime in spring 2024" | `baseline_approx` | `2024-04-15` (midpoint of the stated span, with `schedule_anchor_note` = the user's words) | `computeNextDue(...)` — very likely already overdue, which is correct | Anchor shown with a ≈ marker; history list shows **no** entry |
| "No idea" + user picks a date | `user_chosen` | the picked date | from that date | "Start date chosen at setup" |
| "No idea" + "start now" | `user_chosen` | `today` (calendar kinds: `today - 1`) | `today` for completion-anchored; next series date ≥ today for calendar kinds | "Schedule started at setup" |
| "No idea" + "ask me later" | `none` | NULL | **no occurrence generated**; plan is `status='paused'` and an `app_alert` (kind `low_stock`→ add `'plan_needs_baseline'`) prompts the user | Plan appears in a "needs setup" list |
| New equipment | `install_date` | `asset.installed_on` | computed | Anchor inherits `installed_on_precision` |

For calendar kinds the anchor is only a lower bound, so `baseline_approx` is harmless there; for `interval_from_completion` an approximate anchor propagates its uncertainty, so the occurrence carries `generation_note_json.anchorPrecision='approx'` and the UI never says "overdue by 47 days" — it says "estimated overdue".

### 2.5 Worked examples (household tz `Europe/Helsinki`, delivery `09:00`)

| # | Rule | Anchor | `now` (local) | Result |
|---|---|---|---|---|
| A | `interval_from_completion` 6 months | completion `2026-09-08` | 2026-09-08 | due `2027-03-08`; instant `2027-03-08T07:00:00Z` (EET, UTC+2) |
| B | `interval_from_completion` 1 month | completion `2026-01-31` | 2026-01-31 | due `2026-02-28` (clamped; 2026 is not a leap year). Completing on 2026-02-28 gives `2026-03-28` — drift is intended for completion-anchored rules. |
| C | `fixed_interval` every 1 month, `anchorDate 2026-01-31` | prev due `2026-01-31` | 2026-02-01 | `2026-02-28`; then `2026-03-31`, `2026-04-30`, `2026-05-31`. Computed as `anchor + k months` each time, so **no** 28→28→28 drift. |
| D | `fixed_monthly` months `[4,10]`, day 1 | prev due `2026-04-01`, completed 2026-04-20 | 2026-04-20 | due `2026-10-01`; instant `2026-09-30T…`? No — `2026-10-01T06:00:00Z` (EEST, UTC+3, DST ends 2026-10-25) |
| E | same as D, but completed very late | prev due `2026-04-01` | 2026-12-05 | first series date after `2026-04-01` is `2026-10-01` < today ⇒ rolled; due `2027-04-01`, `missedSeriesDates=['2026-10-01']` |
| F | `fixed_monthly` months `[1..12]`, day `'last'` | prev due `2026-01-31` | 2026-02-01 | `2026-02-28`, then `2026-03-31`, `2026-04-30` |
| G | `fixed_monthly` months `[1..12]`, day `31` | prev due `2026-01-31` | 2026-02-01 | `2026-02-28` (clamped), then `2026-03-31` — clamping never advances the series |
| H | `seasonal_window` 1 May–30 Jun, `dueOn: window_start` | prev due `2026-05-01`, completed 2026-06-12 | 2026-06-12 | due `2027-05-01`, window `2027-05-01`..`2027-06-30` |
| I | same, not completed | prev due `2027-05-01` | 2027-07-05 | occurrence stays open (window closed); reminders continue on `2027-05-08`, `-15`, `-22`, … Completing on `2027-08-02` closes 2027; next due `2028-05-01`. |
| J | `seasonal_window` 15 Nov–15 Feb | prev due `2026-11-15` | 2027-03-01 | window spans New Year; `end = 2027-02-15 < today` ⇒ next due `2027-11-15`, `missedSeriesDates` empty (2026's window was satisfied/closed by its own occurrence) |
| K | `fixed_weekly` `[6]` (Sat), every 2 weeks, anchor `2027-01-02` | prev due `2027-01-02` | 2027-01-03 | `2027-01-16` (skips `2027-01-09`, wrong parity) |

**DST (the part that must be right).** Due dates are local dates; the DST-sensitive step is turning `(due_date + 7n, '09:00', tz)` into an instant. Always recompute per slot; **never** add `7 * 86_400_000` ms.

Spring forward — Helsinki DST starts **Sun 2027-03-28** at 03:00 local (EET +02 → EEST +03):

| slot | local | instant | Δ from previous |
|---|---|---|---|
| n=0 | 2027-03-21 09:00 EET | `2027-03-21T07:00:00Z` | — |
| n=1 | 2027-03-28 09:00 EEST | `2027-03-28T06:00:00Z` | 6 d 23 h |
| n=2 | 2027-04-04 09:00 EEST | `2027-04-04T06:00:00Z` | 7 d |

Fall back — Helsinki DST ends **Sun 2027-10-31** at 04:00 local (EEST +03 → EET +02):

| slot | local | instant | Δ |
|---|---|---|---|
| n=0 | 2027-10-24 09:00 EEST | `2027-10-24T06:00:00Z` | — |
| n=1 | 2027-10-31 09:00 EET | `2027-10-31T07:00:00Z` | 7 d 1 h |
| n=2 | 2027-11-07 09:00 EET | `2027-11-07T07:00:00Z` | 7 d |

Wall-clock delivery is preserved in both directions, which is the binding requirement.

---

## 3. Occurrence lifecycle state machine

### 3.1 States

`status` is a small enum; two orthogonal flags decorate it because blocking and booking must not erase whether the task is due.

```
                        ┌──────────────► cancelled  (plan cancelled)
                        │
   (generate) ──► pending ──(worker: delivery time on due_date)──► due
                        ▲                                          │
      postpone(future)  └──────────────────────────────────────────┘
                                                                   │
        ┌──────────────────────────────┬─────────────────────┬──────┴───────┐
        ▼                              ▼                     ▼              ▼
    completed                      skipped              cancelled       (stays due,
   (completion_id)               (no completion)      (plan cancelled)   overdue derived)
        │
        └── void completion ──► reopened (pending|due)
```

- `pending` — open, not yet announced.
- `due` — open and announced (slot 0 has fired or is claimable). `overdue` is **derived**: `status='due' AND due_date < today`.
- `completed`, `skipped`, `cancelled` — terminal (with `void` as the only way back out of `completed`).

Decorators (not states):
- **blocked**: `blocked_reason IS NOT NULL` (+ `blocked_at_ms`, `blocked_by`). Example reason: "waiting for filters".
- **booked**: `service_booking_id IS NOT NULL`.

Why decorators rather than states: a blocked-and-overdue task is both, and collapsing them into one enum column would either lose information or produce a 12-value enum. Both flags are indexed via `(status, blocked_reason)`.

### 3.2 Transitions

| Transition | Precondition | Effect on `due_date` | Effect on reminders | Next occurrence | Events |
|---|---|---|---|---|---|
| **generate** (plan/manual/condition) | plan `active`; no open occurrence for the plan (partial unique index) | set `due_date` + `original_due_date` | none yet | — | `occurrence_event('created')`, `audit_log` |
| **become due** (worker) | `status='pending'` AND `now >= instantOf(due_date, delivery_time, tz)` | unchanged | creates `notification_recipient_state` per recipient + slot n=0, sends | — | `('became_due')`, `('notified')` |
| **complete** | `status IN ('pending','due')`; not voided completion exists | closes occurrence | **all recipients cleared immediately** (`status='cleared'`, pending slot `cancelled_completed`, `clear` command enqueued per device) | generated per §2 with anchor = completion local date (completion-anchored) or previous `due_date` (calendar) | `('completed')`, `audit_log`, stock txns |
| **postpone(newDueDate, reason)** | `status IN ('pending','due')`; `newDueDate >= today`; `newDueDate <= original_due_date + max_postpone_days` (default 365) | `due_date = newDueDate`; `original_due_date` untouched | **re-anchored**: clear current notifications (the "due now" claim is no longer true), set `recipient_state.anchor_date = newDueDate`, reset `slot_index` to 0 at the new date. Status → `pending` if `newDueDate > today` else stays `due`. | none — this occurrence remains the open one; the **plan interval and anchor are unchanged** | `('postponed', from_due_date, to_due_date, reason)` |
| **snooze(untilInstant, byUser)** | recipient has an active `notification_recipient_state` | **unchanged** | only *that* recipient: pending slot → `snoozed`, new pending slot at `until` with the **same `slot_index`** and `is_snooze=1`. After it fires, the series resumes at `t(index+1)` anchored to the original due date. | none | `('snoozed')` with `recipientUserId` |
| **skip(reason)** | `status IN ('pending','due')` | closes | clear all recipients | generated per §2 with `anchor = { date: this.due_date, source: 'skipped_due_date' }`; `plan.last_completion_id` **untouched** and `schedule_anchor_source='skipped_due_date'` so no fake history | `('skipped', reason)` |
| **cancel plan** | plan `active`/`paused` | closes open occurrence with `close_reason='plan_cancelled'` | clear all recipients | none | `('cancelled')` on occurrence + `audit_log` on plan |
| **block(reason)** | `status IN ('pending','due')`; `blocked_reason IS NULL` | unchanged | **unchanged by default** — binding policy 3 says remind every 7 days while incomplete, and blocking is not completing. The UI offers a combined "Block + snooze until <date>" that additionally performs a snooze for both recipients. | none | `('blocked', reason)` |
| **unblock** | `blocked_reason IS NOT NULL` | unchanged | if a snooze accompanied the block and is still in force, it stays (user can un-snooze) | none | `('unblocked')` |
| **book(providerId, when)** | `status IN ('pending','due')` | unchanged — **booking is not completion and does not move the due date**. The UI offers "also postpone to the appointment date" as a separate, explicit action. | unchanged; UI offers "snooze until the day before the appointment" | none | `('booked')` |
| **reopen** (from `skipped`/`cancelled`) | terminal, `closed_at_ms` within `reopen_window_days` (default 90) | restored `due_date`; recompute `status` from `due_date` vs `today` | recreate recipient states, pending slot index recomputed by the catch-up rule (usually fires a consolidated reminder at once) | the successor occurrence, if it exists and is untouched (no progress rows, no completion, no interacted notification), is `cancelled` with `close_reason='superseded_by_reopen'`; if touched, the reopen is **refused** with a clear explanation | `('reopened')` |
| **void completion** | completion exists, not voided | see §5.4 | re-armed | successor cancelled if untouched, else refuse | `('completion_voided')` |

Guard shared by every transition: it runs inside `BEGIN IMMEDIATE`, re-reads the occurrence row, and asserts the precondition inside the transaction. Terminal→terminal and duplicate transitions are rejected with `409 ConflictError` carrying the current status (except the idempotent completion replay path, §5.2).

### 3.3 Overdue and escalation

`overdue` is derived. Priority is not auto-escalated (no clever heuristics); the UI sorts by `(priority DESC, due_date ASC)` and shows days overdue. `blocked` tasks sort into a separate "waiting" group.

---

## 4. Notification engine

### 4.1 Tables

**`notification_recipient_state`** — one row per (occurrence, recipient).

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `occurrence_id` | TEXT | no | → occurrence ON DELETE CASCADE |
| `recipient_user_id` | TEXT | no | → `user.id` |
| `tag` | TEXT | no | stable notification tag, `'vh:occ:' || occurrence_id || ':' || recipient_user_id` |
| `anchor_date` | TEXT | no | LocalDate — slot series origin; equals `occurrence.due_date`, updated on postpone |
| `state` | TEXT | no | `CHECK IN ('active','snoozed','cleared','suppressed')` |
| `next_slot_index` | INTEGER | no | index of the single pending slot; `CHECK (>= 0)` |
| `snoozed_until_ms` | INTEGER | yes | |
| `snooze_count` | INTEGER | no | default 0 |
| `last_sent_at_ms` | INTEGER | yes | |
| `last_sent_slot_index` | INTEGER | yes | |
| `interacted_at_ms` | INTEGER | yes | first observed HA action for this occurrence+recipient (our only proxy for "delivered") |
| `cleared_at_ms`, `clear_reason` | | yes | `'completed'`,`'skipped'`,`'cancelled'`,`'postponed'`,`'reopened'` |
| `created_at_ms`, `updated_at_ms` | | no | |

Unique: `(occurrence_id, recipient_user_id)`, `(tag)`.
Indexes: `(state, occurrence_id)`, `(recipient_user_id, state)`.

**`reminder_slot`** — the scheduling truth. **At most one non-terminal slot per recipient state**, enforced by index.

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `recipient_state_id` | TEXT | no | → `notification_recipient_state.id` ON DELETE CASCADE |
| `slot_index` | INTEGER | no | 0 = the due-date notification, n = due + n×`reminder_interval_days` |
| `scheduled_at_ms` | INTEGER | no | `instantOf(anchor_date + n×interval, delivery_time, tz)` |
| `scheduled_local_date` | TEXT | no | LocalDate, for debugging/exports |
| `state` | TEXT | no | `CHECK IN ('pending','claimed','sent','failed','snoozed','cancelled','superseded')` |
| `is_snooze` | INTEGER | no | default 0 — a snooze re-fire of the same `slot_index` |
| `consolidated_from_index` | INTEGER | yes | catch-up: the index this slot started as |
| `consolidated_count` | INTEGER | no | default 1 — how many scheduled reminders this one send represents |
| `held_until_ms` | INTEGER | yes | outside the send window |
| `nonce` | TEXT | no | UNIQUE, 128-bit random hex; stable across retries of the same slot |
| `offered_actions_json` | TEXT | yes | exactly the action ids offered, for validation |
| `claimed_by` | TEXT | yes | worker instance id |
| `claim_fence` | INTEGER | yes | lease fence token held at claim time |
| `claim_expires_at_ms` | INTEGER | yes | |
| `attempt_count` | INTEGER | no | default 0 |
| `next_attempt_at_ms` | INTEGER | yes | backoff |
| `sent_at_ms` | INTEGER | yes | **when HA accepted the service call — not proof of delivery** |
| `cancel_reason` | TEXT | yes | |
| `created_at_ms` | | no | |

```sql
CREATE UNIQUE INDEX ux_slot_one_open
  ON reminder_slot(recipient_state_id)
  WHERE state IN ('pending','claimed');
CREATE UNIQUE INDEX ux_slot_nonce ON reminder_slot(nonce);
CREATE INDEX ix_slot_ready ON reminder_slot(state, scheduled_at_ms);
CREATE INDEX ix_slot_state_recipient ON reminder_slot(recipient_state_id, slot_index);
```

`ux_slot_one_open` is the structural reason a restart or a second worker cannot double-schedule: there is physically no second row to claim.

**`ha_notify_command`** — transport outbox. Introduced in addition to the three named tables because **clears must survive an HA outage too**: if a completion happens while HA is down, the "stop reminding" clear cannot be dropped.

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `kind` | TEXT | no | `CHECK IN ('notify','clear')` |
| `notify_service` | TEXT | no | `notify.mobile_app_lucas_iphone` |
| `payload_json` | TEXT | no | exact HA service data |
| `tag` | TEXT | no | |
| `slot_id` | TEXT | yes | → `reminder_slot.id` (for `kind='notify'`) |
| `recipient_state_id` | TEXT | yes | → recipient state |
| `dedupe_key` | TEXT | no | `'notify:' || slot_id || ':' || notify_service` / `'clear:' || tag || ':' || cleared_at_ms` |
| `state` | TEXT | no | `CHECK IN ('queued','claimed','sent','failed','abandoned')` |
| `attempt_count` | INTEGER | no | default 0 |
| `next_attempt_at_ms` | INTEGER | yes | |
| `claimed_by`, `claim_fence`, `claim_expires_at_ms` | | yes | |
| `sent_at_ms` | INTEGER | yes | |
| `last_error` | TEXT | yes | |
| `created_at_ms` | | no | |

Unique: `(dedupe_key)`. Index: `(state, next_attempt_at_ms)`.
Clears are enqueued with a **higher priority** than notifies (drain order: `kind='clear'` first, then `kind='notify'` by `scheduled_at_ms`).

**`delivery_attempt`** — immutable attempt log.

`id` PK · `command_id` → `ha_notify_command.id` CASCADE · `attempt_no` INTEGER · `started_at_ms` · `finished_at_ms` NULL · `outcome` TEXT `CHECK IN ('accepted','ha_unavailable','ha_error','timeout','no_device','invalid_payload')` · `http_status` INTEGER NULL · `ha_response` TEXT NULL (truncated 2 KB) · `error` TEXT NULL · `worker_id` TEXT.
Unique `(command_id, attempt_no)`. Index `(command_id)`, `(started_at_ms)`.

**`notification_action_event`** — inbound HA actions; the replay guard.

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `received_at_ms` | INTEGER | no | |
| `ha_context_id` | TEXT | yes | HA event context id, when present |
| `nonce` | TEXT | yes | from `action_data` |
| `action` | TEXT | no | `'open'`,`'snooze'`,`'done'` |
| `raw_json` | TEXT | no | whole event, for forensics |
| `claimed_occurrence_id`, `claimed_recipient_user_id`, `claimed_slot_id` | TEXT | yes | as asserted by the payload |
| `source_device_name` | TEXT | yes | |
| `validation` | TEXT | no | `CHECK IN ('accepted','duplicate','unknown_nonce','expired','wrong_recipient','occurrence_closed','action_not_offered','device_mismatch','malformed')` |
| `applied_effect` | TEXT | yes | `'snoozed'`,`'completed'`,`'noop'` |
| `completion_id` | TEXT | yes | → completion |
| `processed_at_ms` | INTEGER | yes | |

```sql
CREATE UNIQUE INDEX ux_action_replay ON notification_action_event(nonce, action)
  WHERE nonce IS NOT NULL AND validation = 'accepted';
CREATE INDEX ix_action_context ON notification_action_event(ha_context_id);
```

Every inbound event is recorded, accepted or not. The partial unique index means the **second** accepted `(nonce, action)` insert fails, and the handler converts that failure into `validation='duplicate'` + `applied_effect='noop'`.

**`worker_lease`** · `name` TEXT PK (`'notification_tick'`, `'ha_listener'`, `'outbox_drain'`) · `holder_id` TEXT NULL · `fence` INTEGER NOT NULL DEFAULT 0 · `acquired_at_ms` NULL · `expires_at_ms` NOT NULL DEFAULT 0 · `updated_at_ms`.

**`worker_heartbeat`** · `name` TEXT PK · `worker_id` TEXT · `last_tick_started_ms` · `last_tick_finished_ms` · `last_ok_ms` · `tick_count` INTEGER · `last_error` TEXT NULL · `ha_connected` INTEGER · `ha_last_connected_ms` NULL. This table is how the worker learns, after a restart, that an outage happened.

### 4.2 Slot arithmetic

For a recipient state with `anchor_date = A`, household `delivery_time = D`, `tz`, `reminder_interval_days = I` (default 7):

```
t(n) = instantOf(addDaysLocal(A, I * n), D, tz)          n = 0, 1, 2, …
```

Recomputed from the local date on every use. `t(0)` is the "task is due" notification — **no advance reminders**, per binding policy 1.

### 4.3 Lease and claim

```ts
// acquire or renew; returns the fence token or null
function acquireLease(name: string, workerId: string, ttlMs: number, now: Instant): number | null {
  return db.transaction(() => {
    const r = db.get(sql`SELECT holder_id, fence, expires_at_ms FROM worker_lease WHERE name = ${name}`);
    const canTake = !r || r.expires_at_ms <= now || r.holder_id === workerId;
    if (!canTake) return null;
    const fence = (r?.holder_id === workerId ? r.fence : (r?.fence ?? 0) + 1);
    const res = db.run(sql`
      UPDATE worker_lease
         SET holder_id = ${workerId}, fence = ${fence},
             acquired_at_ms = ${now}, expires_at_ms = ${now + ttlMs}, updated_at_ms = ${now}
       WHERE name = ${name}
         AND (holder_id IS NULL OR expires_at_ms <= ${now} OR holder_id = ${workerId})`);
    return res.changes === 1 ? fence : null;
  }, { behavior: 'immediate' });
}
```

TTL 90 s, renewed every tick (60 s). Each slot claim stamps `claim_fence`. Before finalising a send, the worker re-reads the lease inside the finalise transaction and aborts if `holder_id !== workerId || fence !== claimFence`. So even with two workers running, the loser cannot write `sent`, and its claim expires and is reclaimed. Duplicate *pushes* are still conceivable in a torn-network scenario — which is exactly why the notification tag replaces rather than stacks, and why every action carries a nonce.

### 4.4 Worker tick algorithm

Runs every `N = 1` minute (configurable) for scheduling; the outbox drain runs every 5 s; the HA WebSocket listener is event-driven. All three are the same process, guarded by separate leases.

```
tick(now):
  fence = acquireLease('notification_tick', workerId, 90_000, now)
  if fence == null: return                       // another worker holds it

  hb = readHeartbeat('notification_tick')
  outageMs = hb?.last_ok_ms ? now - hb.last_ok_ms : 0
  inCatchUp = outageMs > household.catchup_gap_minutes * 60_000
  writeHeartbeat(last_tick_started_ms = now)

  // ---- PHASE 1: materialise recipient states (tx per occurrence, IMMEDIATE) ----
  for occ in SELECT * FROM maintenance_occurrence WHERE status IN ('pending','due'):
     recipients = occ.assignment_mode == 'shared'
                    ? [all active users]
                    : [occ.assignee_user_id ?? plan fallback ?? all active users]
     for u in recipients:
        upsert notification_recipient_state(occ.id, u) with anchor_date = occ.due_date, state='active'
     mark states for non-recipients as state='suppressed'   // assignment changed after generation

  // ---- PHASE 2: pending -> due, and create slot 0 ----
  for occ in SELECT * FROM maintenance_occurrence WHERE status='pending':
     if now >= instantOf(occ.due_date, D, tz):
        tx IMMEDIATE:
          re-read occ; if status != 'pending': continue
          UPDATE occ SET status='due', became_due_at_ms=now
          insert occurrence_event('became_due')
          for st in active recipient states of occ:
             if no slot exists for st: insert reminder_slot(st, index=0, scheduled_at=t(0), state='pending', nonce=random())

  // ---- PHASE 3: heal missing slots ----
  //  (a state that is 'active', has no non-terminal slot, and whose occurrence is 'due')
  for st in states needing a slot:
     insert reminder_slot(st, index = st.next_slot_index, scheduled_at = t(st.next_slot_index),
                          state='pending', nonce=random())
     // the partial unique index makes a concurrent duplicate insert fail harmlessly

  // ---- PHASE 4: fast-forward (catch-up consolidation) ----
  for slot in SELECT * FROM reminder_slot WHERE state='pending' AND scheduled_at_ms <= now:
     st = slot.recipient_state
     if slot.is_snooze: nStar = slot.slot_index            // a snooze fire is never consolidated
     else:
        nStar = slot.slot_index
        while t(nStar + 1) <= now: nStar += 1
     if nStar > slot.slot_index:
        tx IMMEDIATE: UPDATE reminder_slot
                         SET slot_index = nStar,
                             scheduled_at_ms = t(nStar),
                             scheduled_local_date = ...,
                             consolidated_from_index = COALESCE(consolidated_from_index, slot_index),
                             consolidated_count = nStar - COALESCE(consolidated_from_index, slot_index) + 1
                       WHERE id = slot.id AND state='pending'

  // ---- PHASE 5: send window guard ----
  for slot in pending && scheduled_at_ms <= now:
     lateBy = now - slot.scheduled_at_ms
     if lateBy > household.slot_grace_minutes*60_000 and localTimeOf(now, tz) not in [send_window_start, send_window_end]:
        UPDATE slot SET held_until_ms = instantOf(nextSendWindowOpen(now, tz))   // do not send at 03:00
        continue

  // ---- PHASE 6: digest decision (per recipient) ----
  for u in users:
     ready = slots ready to send for u (post-guard)
     if inCatchUp and count(ready) > household.catchup_digest_threshold:
        enqueue ONE digest command (tag 'vh:digest:' + u, actions: [Open list])
        for slot in ready: claim; mark sent with sent_via='digest', digest_command_id=…; advance series
     else:
        for slot in ready: sendOne(slot)

  // ---- PHASE 7: sendOne(slot) ----
  claim: tx IMMEDIATE
           UPDATE reminder_slot SET state='claimed', claimed_by=workerId, claim_fence=fence,
                                    claim_expires_at_ms = now + 120_000, attempt_count = attempt_count + 1
            WHERE id = slot.id AND state='pending'
         assert changes == 1 else skip (someone else took it)
         for dev in active devices of recipient:
            insert ha_notify_command(kind='notify', notify_service=dev.notify_service,
                                     payload_json = buildPayload(slot), tag = st.tag,
                                     slot_id = slot.id, dedupe_key = 'notify:'||slot.id||':'||dev.notify_service,
                                     state='queued')
         if no devices: UPDATE slot SET state='failed'; raise app_alert('notify_device_missing')

  // ---- PHASE 8: heartbeat ----
  writeHeartbeat(last_tick_finished_ms = now2, last_ok_ms = now2, tick_count += 1)
```

**Outbox drain (every 5 s, lease `outbox_drain`):**

```
for cmd in SELECT * FROM ha_notify_command
             WHERE state='queued' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= now)
             ORDER BY (kind='clear') DESC, created_at_ms ASC LIMIT 20:
   claim (state='claimed', fence) ; insert delivery_attempt(started)
   if !ha.connected: finish attempt outcome='ha_unavailable';
        UPDATE cmd SET state='queued', attempt_count+1, next_attempt_at_ms = now + backoff(attempt_count)
        continue
   try  ha.callService(cmd.notify_service, cmd.payload)
        finish attempt outcome='accepted', http_status
        tx IMMEDIATE (verify fence):
           UPDATE cmd  SET state='sent', sent_at_ms = now
           if cmd.kind='notify' and all sibling commands for slot are 'sent':
              UPDATE reminder_slot SET state='sent', sent_at_ms=now WHERE id = cmd.slot_id
              UPDATE notification_recipient_state
                 SET last_sent_at_ms=now, last_sent_slot_index=slot.slot_index,
                     next_slot_index = slot.slot_index + 1
              insert next reminder_slot(index = slot.slot_index + 1, scheduled_at = t(slot.slot_index+1),
                                        state='pending', nonce=random())
              insert occurrence_event('notified')
   catch e:
        finish attempt outcome = classify(e)
        UPDATE cmd SET state='queued', next_attempt_at_ms = now + backoff(attempt_count)
        if attempt_count >= 200: state='abandoned'; app_alert('worker_outage')
```

Backoff: `30 s, 1 m, 2 m, 5 m, 15 m, 30 m` then constant 30 m.

Because `nStar` is chosen as the largest `n` with `t(n) <= now`, the freshly inserted slot `nStar+1` is always in the future — no immediate re-fire loop is possible.

### 4.5 Catch-up consolidation — the exact rules

1. **Trigger.** Catch-up applies whenever a pending slot is later than `slot_grace_minutes`, regardless of cause (worker down, HA down, machine asleep). `inCatchUp` (heartbeat gap > `catchup_gap_minutes`) only additionally switches on the *digest* behaviour.
2. **Never replay.** For a recipient state, `nStar = max{ n ≥ pendingIndex : t(n) ≤ now }`. Exactly **one** notification is sent, carrying `slot_index = nStar`, `consolidated_from_index = pendingIndex`, `consolidated_count = nStar - pendingIndex + 1`. No rows are created for the skipped slots; the fired slot row *is* the record, and `occurrence_event('notified')` carries `{consolidatedCount}`.
3. **Anchor is preserved.** The next slot is `t(nStar + 1)`, computed from the **original** `anchor_date`. The weekly rhythm stays locked to the due date; an outage does not shift it.
4. **Per (occurrence, recipient) granularity.** Each open occurrence gets its own consolidated notification, because tags and actions are per-occurrence and the user needs per-task actions. This is a deliberate reading of "ONE consolidated catch-up reminder": one per task, not one replay per missed week.
5. **Digest escape hatch.** When more than `catchup_digest_threshold` (default 3) occurrences would fire for the same recipient in the same catch-up tick, send a **single** digest notification instead (tag `vh:digest:<userId>`, body "5 tasks are overdue", one `Open` action to the task list). Each underlying slot is still advanced and marked `sent` with `sent_via='digest'`, so the weekly rhythm continues and nothing is lost. Rationale: after a week-long outage, ten separate pushes at once is worse than one.
6. **Snooze fires are exempt.** A slot with `is_snooze=1` is never consolidated or fast-forwarded; it fires once at the snooze time and then hands back to the anchored series.
7. **Send-window guard.** A late slot outside `[send_window_start, send_window_end]` is held until the next window opening. A slot that is on time (within grace) always sends, so a delivery time deliberately set to 06:00 still works.
8. **Message wording.** The payload for `consolidated_count > 1` says: *"Overdue since 4 Jan · 5 reminders while offline"*. For `slot_index = 0`: *"Due today"*. For `slot_index ≥ 1`: *"Overdue by 14 days"*.

**Worked catch-up example.** Due `2027-01-04`, `I = 7`, `D = 09:00`, tz Helsinki (EET, +02 all through January).
`t(0)=2027-01-04T07:00Z`, `t(1)=01-11T07:00Z`, `t(2)=01-18T07:00Z`, `t(3)=01-25T07:00Z`, `t(4)=02-01T07:00Z`, `t(5)=02-08T07:00Z`.
Mac mini offline 2027-01-03 → 2027-02-03 12:00 local (`now = 2027-02-03T10:00Z`).
On the first tick after restart: pending slot index 0; `t(4) ≤ now < t(5)` ⇒ `nStar = 4`. The slot is updated to index 4, `consolidated_from_index = 0`, `consolidated_count = 5`. Local time is 12:00, inside the send window ⇒ send now. One notification per recipient. Next pending slot: index 5 at `2027-02-08T07:00Z` — still anchored to 4 Jan. ✔

### 4.6 Payload, tag scheme, and actions

Tag: `vh:occ:<occurrenceId>:<recipientUserId>` (stored on the recipient state, so it is stable for the lifetime of the occurrence). Digest tag: `vh:digest:<userId>`. Because iOS replaces a notification with the same tag, week 3's reminder overwrites week 2's automatically — no stacking, and no need to clear before sending.

```ts
function buildPayload(slot, st, occ): HaNotifyPayload {
  const actions = decideActions(occ);          // see below
  return {
    title: occ.title,
    message: bodyFor(slot, occ),               // "Due today" | "Overdue by 14 days" | consolidated wording
    data: {
      tag: st.tag,
      url: `${appBaseUrl}/tasks/${occ.id}`,    // tapping the body opens the task
      group: 'virtual-home-maintenance',
      push: { 'thread-id': 'virtual-home' },
      actions,
      action_data: {
        v: 1,
        occurrenceId: occ.id,
        recipientUserId: st.recipient_user_id,
        slotId: slot.id,
        nonce: slot.nonce,
      },
    },
  };
}

function decideActions(occ) {
  const a = [
    { action: 'URI',    title: 'Open',   uri: `${appBaseUrl}/tasks/${occ.id}` },
    { action: 'vh_snooze', title: 'Snooze 1 day' },
  ];
  if (allowQuickDone(occ)) a.push({ action: 'vh_done', title: 'Done' });
  else a.push({ action: 'URI', title: 'Complete…', uri: `${appBaseUrl}/tasks/${occ.id}/complete` });
  return a;
}
```

`allowQuickDone(occ)` is **true only when nothing needs to be recorded or chosen**:
- no required material lines (from plan ∪ procedure ∪ asset consumables), **or** every required line has an unambiguous part+lot and sufficient stock;
- no checklist item with `requires_value`;
- `occ.assignment_mode='shared'` is fine (either user may complete);
- the plan does not require a professional;
- the plan/procedure does not set `requires_completion_notes`.

Computed at send time and **written into `slot.offered_actions_json`**, so validation later compares against what was actually offered, not against what the rules would say today.

Note on the HA companion app: `action: 'URI'` with a `uri` opens the URL directly; custom actions (`vh_snooze`, `vh_done`) come back as `mobile_app_notification_action` events with `action_data` echoed. Only the custom ones need server handling.

### 4.7 Inbound action handling

```
onHaEvent(event):                       // mobile_app_notification_action
  ad = event.data.action_data ?? {}
  ev = insert notification_action_event(raw, nonce=ad.nonce, action=event.data.action,
                                        claimed_* = ad.*, source_device_name=event.data.device_name,
                                        validation='malformed')   // pessimistic default
  tx IMMEDIATE:
    if !ad.nonce or ad.v !== 1:                       -> validation='malformed';        return
    slot = SELECT * FROM reminder_slot WHERE nonce = ad.nonce
    if !slot:                                         -> 'unknown_nonce';               return
    st  = recipient_state(slot)
    if st.recipient_user_id !== ad.recipientUserId:   -> 'wrong_recipient';             return
    if st.occurrence_id      !== ad.occurrenceId:     -> 'wrong_recipient';             return
    if slot.id               !== ad.slotId:           -> 'malformed';                   return
    if now - slot.created_at_ms > action_ttl_days:    -> 'expired';                     return
    offered = JSON.parse(slot.offered_actions_json ?? '[]')
    if event.data.action not in offered ids:          -> 'action_not_offered';          return
    dev = device by source_device_name
    if dev and dev.user_id !== st.recipient_user_id:  -> 'device_mismatch';             return   // log, do not act
    occ = occurrence(st.occurrence_id)
    if occ.status not in ('pending','due'):           -> 'occurrence_closed';           return   // stale tap after completion
    // replay guard: this insert is the atomic gate
    UPDATE notification_action_event SET validation='accepted' WHERE id = ev.id
      -- if ux_action_replay raises UNIQUE -> set validation='duplicate', applied_effect='noop', return
    switch event.data.action:
      case 'vh_snooze': applySnooze(st, until = instantOf(today+1, delivery_time, tz), actor = st.recipient_user_id)
                        applied_effect='snoozed'
      case 'vh_done':   completeOccurrence({ occurrenceId: occ.id,
                                             completionRequestId: 'act:' + ad.nonce,   // <= idempotency
                                             performedByUserId: st.recipient_user_id,
                                             materials: expectedMaterials(occ),
                                             source: 'notification_action' })
                        applied_effect='completed'
    UPDATE st SET interacted_at_ms = COALESCE(interacted_at_ms, now)   // the closest thing to 'delivered'
```

Replay protection is **two-layered and both layers matter**:
1. `notification_action_event` partial unique on `(nonce, action)` — the same tap arriving twice from HA is rejected at the DB.
2. `completion.request_id = 'act:' + nonce` unique — even if layer 1 were bypassed (e.g. the event arrives on two different HA connections and both pass validation in a race), the completion transaction returns the *existing* completion and performs **no second stock deduction**.

Snooze is explicitly harmless: it writes `notification_recipient_state` + one `reminder_slot` + one `occurrence_event`. It touches no `completion`, no `stock_transaction`, no `due_date`, and no `maintenance_plan`. A test asserts exactly that (§9).

### 4.8 Clearing on completion

Inside the completion transaction (§5.1 step 8): for every `notification_recipient_state` of the occurrence — **both users, immediately, regardless of who completed** — set `state='cleared'`, cancel the pending slot, and enqueue one `ha_notify_command(kind='clear')` per active device with payload `{ message: 'clear_notification', data: { tag } }`. Same for `skip` and `cancel`.

If HA is down at that moment, the clear sits in the outbox and drains on reconnect (clears drain before notifies). The user's phone may keep showing a stale notification until then; tapping it hits the `occurrence_closed` validation path and is a no-op, and the app screen it opens shows the completion. That is the correct failure mode.

### 4.9 `sent` vs `delivered`

`reminder_slot.sent_at_ms` is set **only** when HA's service call returns success. We record `sent`, never `delivered`, because HA→APNs→device is not observable to us and delivery is not exactly-once. The only positive delivery evidence we ever get is an action event, recorded as `notification_recipient_state.interacted_at_ms`. Nothing in the scheduling logic depends on delivery confirmation: the weekly cadence continues from the anchored series whether or not the push landed, which is precisely the behaviour policy 3 asks for.

---

## 5. Completion + inventory transaction

### 5.1 The transaction, step by step

Input (`CompleteOccurrenceInput`):

```ts
{
  completionRequestId: string;      // client-generated UUIDv7, REQUIRED
  occurrenceId: string;
  completedAtMs: number;            // may be in the past
  completedAtPrecision?: 'exact' | 'day' | 'month';
  performedByUserId?: string;
  performedByProviderId?: string;
  recordedByUserId: string;
  notes?: string;
  effortMinutes?: number;
  outcome?: 'done' | 'done_with_issues' | 'partial';
  materials: Array<{
    partId: string; lotId?: string; storagePlaceId?: string;
    expectedQtyMilli?: number; actualQtyMilli: number;
    resolutionIfShort?: 'adjust_up' | 'consume_available' | 'note_discrepancy';
  }>;
  replacement?: { newAsset: NewAssetInput | { existingAssetId: string }; reason: string };
  procedureProgressFinalised?: boolean;
  source: 'web' | 'notification_action' | 'import';
}
```

All of the following runs in **one** `BEGIN IMMEDIATE` transaction:

1. **Idempotency probe.** `SELECT * FROM completion WHERE request_id = ?`. If found: commit and return `{ completion, idempotentReplay: true }`. No stock movement, no state change, no notification, no audit row. This is the single most important line in the system.
2. **Load and guard.** Read the occurrence `FOR UPDATE`-equivalent (we already hold the write lock). Assert `status IN ('pending','due')`. If `status='completed'` with a *different* `request_id`, throw `ConflictError` carrying the existing completion id (the UI shows "already completed by Marja at 10:14"). If `cancelled`/`skipped`, throw `ConflictError`.
3. **Derive dates.** `completed_local_date = localDateOf(completedAtMs, tz)`. Reject `completedAtMs > now + 5 min` (no future completions). Warn (not reject) if `completed_local_date < occurrence.created` — backdating is legitimate.
4. **Insert `completion`** with `request_id`, and snapshots of `plan_id`, `asset_id`, `procedure_version_id`. `stock_resolution` set provisionally to `'none'`.
5. **Per material line, in input order** (deterministic, so tests are stable):
   a. `available = SELECT COALESCE(SUM(qty_milli),0) FROM stock_transaction WHERE part_id = ? [AND lot_id = ?]`.
   b. Reject `actualQtyMilli < 0`; a line with `actualQtyMilli = 0` writes a `completion_material` row with no stock transaction (useful record: "we expected to use a filter, we did not").
   c. If `actual <= available` → one `stock_transaction(kind='consumption', reason='maintenance_consumption', qty_milli = -actual, completion_id, occurrence_id, occurred_at_ms = completedAtMs, transaction_group_id = G)`; `resolution='sufficient'`.
   d. If `actual > available` → **the reconciliation branch. The completion is never lost and stock is never invented.** `resolutionIfShort` is mandatory here; if absent, the whole transaction is rolled back with `InsufficientStockError { partId, available, requested, options: ['adjust_up','consume_available','note_discrepancy'] }` and the UI presents the three choices (with the already-entered completion data preserved client-side).
      - `adjust_up`: `stock_transaction(kind='adjustment', reason='reconcile_missing_stock', qty = +(actual - available))` then the consumption `-actual`. Net stock 0. Meaning: "there was more on the shelf than recorded".
      - `consume_available`: consumption `-available` (skipped entirely if `available <= 0`); `completion_material.actual_qty_milli = actual` (what was really used), `shortfall_milli = actual - max(available,0)`; `resolution='consumed_available'`. Meaning: "we only had this much recorded; the rest came from somewhere unrecorded".
      - `note_discrepancy`: consumption `-actual`, letting the balance go negative; raise `app_alert('negative_stock')`; `resolution='discrepancy_noted'`. Meaning: "record the truth now, fix the books later".
   e. Insert `completion_material` with `expected`, `actual`, `shortfall`, `resolution`, `stock_transaction_id`.
   f. Lot handling: if `part.tracks_lots` and no `lotId` given, pick the open lot with the earliest `expires_on` (FEFO), else the earliest `purchased_on`; record the choice in `completion_material.notes`. For `tracking_mode='estimated'`, additionally update `part_lot.estimate_pct` and write an `estimate_update` transaction for the implied delta.
6. **Set `completion.stock_resolution`** to the "worst" line resolution (`discrepancy_noted` > `consumed_available` > `adjusted_up` > `sufficient` > `none`).
7. **Close the occurrence:** `status='completed'`, `completion_id`, `closed_at_ms = now`, `close_reason='completed'`. Progress rows are left intact as part of the record.
8. **Notifications:** for each `notification_recipient_state` of the occurrence → `state='cleared'`, `cleared_at_ms=now`, `clear_reason='completed'`; pending/claimed slot → `state='cancelled'`, `cancel_reason='completed'`; enqueue `ha_notify_command(kind='clear')` per active device of each recipient. (§4.8)
9. **Replacement, if present** (§5.5).
10. **Next occurrence:** if the plan is `active` and the rule is recurring:
    - anchor = `{ date: completion.completed_local_date, source: 'completion' }` for `interval_from_completion`; `{ date: occurrence.due_date, source: 'completion' }` for calendar/seasonal kinds.
    - `next = computeNextDue(rule, anchor, now, tz)`; insert the new occurrence (`status='pending'`, `original_due_date = next.dueDate`, `generation_note_json` including `missedSeriesDates`), snapshotting plan fields and resolving `procedure_version_id`.
    - If the insert violates `ux_occ_open_per_plan`, **the whole transaction aborts** — that index firing means a duplicate open occurrence existed, which is a bug we want loudly, not a silent second task.
    - Update `plan.last_completion_id`, `plan.schedule_anchor_date = anchor.date`, `plan.schedule_anchor_source='completion'`.
11. **Events and audit:** `occurrence_event('completed')`; `audit_log` rows for the completion, for each non-`sufficient` stock resolution, and for the plan anchor update.
12. **Commit.** The outbox drain (separate loop, 5 s) delivers the clears. Nothing about the transaction's correctness depends on HA being reachable.

Post-commit, out of transaction: thumbnail generation for attached photos, `app_alert` recomputation for low stock (or defer to the next inventory tick).

### 5.2 Concurrency: two people press Done at once

Both requests carry **different** `completionRequestId`s (each client generated its own). Both take `BEGIN IMMEDIATE`; SQLite serialises them.

- Winner: passes step 2, writes everything, commits.
- Loser: `BEGIN IMMEDIATE` succeeds after the winner commits, step 1's probe misses (different request id), step 2 reads `status='completed'` and throws `ConflictError` → rolled back. **Zero stock deducted twice, one completion, one next occurrence.**
- The loser's UI shows "Marja already completed this at 10:14 — view it?".

The same tap arriving twice (retry, or HA re-emitting the event) carries the **same** `completionRequestId` (`'act:' + nonce` for notification actions; the client's stable id for web) and short-circuits at step 1. Both paths are covered by tests.

### 5.3 Insufficient stock — UX contract

The server never guesses. `InsufficientStockError` is a structured 409 body:

```json
{ "error": "insufficient_stock",
  "lines": [{ "partId": "…", "partName": "HEPA F7 200×200",
              "availableMilli": 1000, "requestedMilli": 2000,
              "options": ["adjust_up", "consume_available", "note_discrepancy"] }] }
```

The completion form keeps every field the user typed and adds a per-line radio group. Retrying with `resolutionIfShort` set **reuses the same `completionRequestId`** — so if the first attempt actually committed (network lost the response), the retry is an idempotent replay, not a double completion.

### 5.4 Undo / correction

Nothing is deleted; corrections are reversals.

**Void a completion** (`voidCompletion({ completionId, reason, actorUserId, requestId })`), one `IMMEDIATE` transaction:

1. Idempotency probe on `audit_log.request_id` (or a small `void_request` unique index on `completion.void_request_id`).
2. Assert `completion.voided_at_ms IS NULL`.
3. **Successor check.** Find the plan's current open occurrence. If it is the successor generated by this completion (`generation_note_json.generatedByCompletionId = completionId`) **and** it is untouched — no `occurrence_progress_item`, no live `completion`, no `notification_action_event` with `applied_effect != 'noop'` referencing it — then `status='cancelled'`, `close_reason='superseded_by_void'`, clear its notifications. If it **is** touched, abort with `CannotVoidError` listing what blocks it; the user must handle that occurrence first. Never delete it.
4. For each `stock_transaction` of the completion, insert a mirror row: `qty_milli = -original`, `kind='correction'`, `reason='completion_voided'`, `reverses_transaction_id = original.id`, `transaction_group_id = G2`, `occurred_at_ms = now`. The unique index on `reverses_transaction_id` makes double-reversal impossible.
5. `completion.voided_at_ms/by/reason`. The row and its `completion_material` children stay, so history reads "completed 12 Jun, voided 14 Jun by Lucas (wrong task)".
6. Reopen the occurrence: `status = due_date <= today ? 'due' : 'pending'`, `completion_id = NULL`, `closed_at_ms = NULL`; recreate/reactivate `notification_recipient_state` rows with `anchor_date = due_date`, `next_slot_index` recomputed by the catch-up rule (usually fires one consolidated reminder on the next tick, correctly).
7. `plan.last_completion_id` reverts to the most recent non-voided completion for the plan; `plan.schedule_anchor_date/source` recomputed from it (or back to the pre-existing baseline if there is none).
8. `occurrence_event('completion_voided')` + `audit_log`.

**Correct a completion without voiding** (fix a typo'd quantity, wrong date): allowed fields are `notes`, `effort_minutes`, `outcome`, `performed_by_*`, and material quantities. A quantity change writes a `stock_transaction(kind='correction', reason='manual_correction', qty = newActual - oldActual, transaction_group_id)` and updates `completion_material.actual_qty_milli`; the original consumption row is never touched. Changing `completed_at_ms` on a completion that seeded a successor triggers the same "is the successor untouched?" check and, if clear, regenerates the successor's due date.

**Plain stock correction** (stock take): `stock_transaction(kind='adjustment', reason='stock_take', qty = counted - recorded)` with the count in `notes`. Never an UPDATE.

### 5.5 Equipment replacement

Recorded so the old unit keeps its whole history and the new install is unmistakably distinct.

Inside the completion transaction, when `input.replacement` is present:

1. Create (or take) the **new** `asset` row: `status='installed'`, `installed_on = completed_local_date`, `installed_on_precision='exact'`, `replaces_asset_id = oldAssetId`, copying `location_id`, `category`, `parent_asset_id`, and (with the user's confirmation) `asset_consumable` rows and `asset_ha_link` rows from the old asset.
2. Old asset: `status='removed'`, `removed_on = completed_local_date`, `replaced_by_asset_id = newAsset.id`.
3. `asset_replacement(old_asset_id, new_asset_id, occurrence_id, completion_id, replaced_on, reason)`.
4. `completion.is_replacement = 1`. Its `asset_id` snapshot stays the **old** asset — "the filter in the old unit was replaced" — which is what makes history queries per-unit honest. The new asset's history begins with the `asset_replacement` row and the install date.
5. Repoint forward-looking references: `maintenance_plan.asset_id = newAsset.id` for every active plan on the old asset (with an `audit_log` diff per plan). Past `completion` rows keep the old `asset_id` and are never rewritten.
6. HA links: the old asset's `asset_ha_link` rows are set to `link_state='replaced'` and cloned onto the new asset as `link_state='active'` if the HA device is the same physical registry entry, or left for the user to re-link if not (an `app_alert('ha_link_missing')` prompts).
7. Because the next due date for `interval_from_completion` is anchored on the completion date, "6 months after replacement" falls out for free (§2.5 example A).

UI reads: the asset page for the new unit shows "Replaced <old unit> on 8 Sep 2026" with a link; the old unit's page is read-only and shows its full completion list plus "Replaced by <new unit>".

---

## 6. Low-battery derived tasks

### 6.1 Tables

**`condition_rule`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `kind` | TEXT | no | `CHECK IN ('low_battery','unavailable_device','threshold_below','threshold_above')` |
| `name` | TEXT | no | |
| `scope` | TEXT | no | `CHECK IN ('all_batteries','asset','entity')` |
| `asset_id` | TEXT | yes | → asset |
| `ha_entity_registry_id` | TEXT | yes | → ha_entity |
| `threshold_pct` | INTEGER | yes | falls back to `household_setting.battery_threshold_pct` |
| `clear_threshold_pct` | INTEGER | yes | `CHECK (clear_threshold_pct IS NULL OR clear_threshold_pct > threshold_pct)` |
| `sustain_minutes`, `clear_sustain_minutes` | INTEGER | yes | |
| `procedure_id` | TEXT | yes | → procedure |
| `default_part_id` | TEXT | yes | → part (fallback when the asset has no `asset_consumable` battery row) |
| `priority` | TEXT | no | default `'normal'` |
| `assignment_mode`, `assignee_user_id` | | | as plan |
| `title_template` | TEXT | no | `'Replace battery: {{asset}}'` |
| `enabled` | INTEGER | no | default 1 |
| audit quad | | | |

**`condition_signal`** — **latest value only. No telemetry history is copied.**

| column | type | null | notes |
|---|---|---|---|
| `ha_entity_registry_id` | TEXT PK | no | → `ha_entity.registry_id` ON DELETE CASCADE |
| `raw_state` | TEXT | no | verbatim |
| `numeric_value` | REAL | yes | NULL when not parseable |
| `is_valid` | INTEGER | no | 0 for `unknown`/`unavailable`/empty/non-numeric |
| `invalid_reason` | TEXT | yes | `'unknown'`,`'unavailable'`,`'non_numeric'`,`'missing_unit'` |
| `last_changed_ms`, `last_updated_ms` | INTEGER | no | from HA |
| `observed_at_ms` | INTEGER | no | when we saw it |
| `below_since_ms` | INTEGER | yes | first *valid* reading at/below threshold in the current run |
| `above_since_ms` | INTEGER | yes | first *valid* reading at/above clear threshold in the current run |
| `is_stale` | INTEGER | no | derived: `observed_at_ms - last_updated_ms > battery_stale_hours` |

**`condition_episode`** — the history that *is* worth keeping.

`id` PK · `rule_id` → condition_rule · `ha_entity_registry_id` → ha_entity · `asset_id` NULL → asset · `opened_at_ms` · `opened_value` REAL · `open_local_date` TEXT · `closed_at_ms` NULL · `closed_value` REAL NULL · `close_reason` TEXT NULL `CHECK IN (NULL,'recovered','entity_removed','rule_disabled','manual','completed')` · `occurrence_id` NULL → occurrence · `min_value` REAL · `notes`.
Partial unique: `UNIQUE (rule_id, ha_entity_registry_id) WHERE closed_at_ms IS NULL` — one open episode per rule+entity.

### 6.2 Battery entity selection and dedupe

HA typically exposes several related entities per battery device: `sensor.x_battery` (device_class `battery`, unit `%`), `sensor.x_battery_voltage` (device_class `voltage`, unit `V`), and `sensor.x_battery_type` (an enum, state `"AAA"`). Only the first is a level.

Selection, evaluated per `ha_device.device_id`:

1. **Candidates**: `ha_entity` rows where `device_class = 'battery'` AND `unit_of_measurement = '%'` AND not `disabled`/`hidden`.
2. **Hard exclusions**: `device_class IN ('voltage','enum')`; `unit IN ('V','mV')`; entities whose latest `raw_state` is non-numeric (this is what filters the `"AAA"` battery-type sensor even if it were mislabelled); `entity_id` matching `_battery_type$`, `_battery_voltage$`, `_battery_state$`, `_battery_plugged`.
3. **Ranking** among survivors: (i) an explicit `asset_ha_link` with `role='battery_level'` wins outright — the manual override; (ii) `entity_id` ending `_battery`; (iii) shortest `entity_id`; (iv) lowest `registry_id` (deterministic tiebreak).
4. The winner is cached as `ha_device.canonical_battery_entity_id`, recomputed on each registry sync, with the change written to `audit_log`.
5. Multi-battery devices (rare — e.g. a hub reporting two packs) are handled only via the manual `asset_ha_link` override, which may pin more than one entity by giving each a distinct `role` suffix. Default behaviour stays one-per-device.

The `sensor.x_battery_type` entity is still *useful*: it tells us the battery is AAA. It is stored as `ha_entity` and read to suggest `asset_consumable.part_id`, but it is never a level signal.

### 6.3 Evaluation with hysteresis (runs on each HA state change and on each worker tick)

```
onState(entityRegistryId, raw, lastUpdatedMs, now):
  v = parseFloat(raw)
  valid = raw not in ('unknown','unavailable','','none') and Number.isFinite(v)
  upsert condition_signal(raw_state=raw, numeric_value = valid ? v : null, is_valid = valid,
                          invalid_reason = …, last_updated_ms, observed_at_ms = now)

  if !valid:
     // NEVER treat as 0%. Do not touch below_since/above_since — the sustain clock is frozen,
     // not restarted, so a 30-second 'unavailable' blip mid-episode does not cancel it.
     if raw in ('unknown','unavailable'): raise app_alert('stale_sensor', dedupe per entity) after
                                          battery_stale_hours of continuous invalidity
     return

  if now - lastUpdatedMs > battery_stale_hours*3600_000:
     signal.is_stale = 1
     raise app_alert('stale_sensor')      // a data-quality alert, NOT a maintenance task
     return                               // stale values never open or close an episode

  rule = matching enabled condition_rule (entity-specific > asset > all_batteries)
  lo = rule.threshold_pct       ?? household.battery_threshold_pct        // 15
  hi = rule.clear_threshold_pct ?? household.battery_clear_pct            // 30
  sustainLo = rule.sustain_minutes       ?? household.battery_sustain_minutes        // 120
  sustainHi = rule.clear_sustain_minutes ?? household.battery_clear_sustain_minutes  // 360

  if v <= lo:
     signal.above_since_ms = null
     signal.below_since_ms ??= now
     if now - signal.below_since_ms >= sustainLo*60_000 and no open episode:
        openEpisode()
  else if v >= hi:
     signal.below_since_ms = null
     signal.above_since_ms ??= now
     if now - signal.above_since_ms >= sustainHi*60_000 and open episode exists:
        closeEpisode('recovered')
  else:
     // dead band lo < v < hi: change nothing. This is the anti-flap.
     // A battery oscillating 14/16/13/17 neither opens nor closes anything after the first decision.
```

Two independent anti-flap mechanisms, both required:
- **Dead band** (`lo` … `hi`, default 15 % … 30 %): a reading in between changes no state.
- **Sustain timers** (2 h to open, 6 h to close): a single spurious sample does nothing.
And a third protection: invalid readings freeze rather than reset the timers, so connectivity blips neither trigger nor cancel.

### 6.4 Opening an episode → an occurrence

`openEpisode()` in one `IMMEDIATE` transaction:

1. Insert `condition_episode` (the partial unique index guarantees one open episode per rule+entity).
2. Resolve `asset_id`: via `asset_ha_link` on the entity, else on its `ha_device_id`. If none, do **not** create a task — raise `app_alert('ha_link_missing')` asking the user to link the device to an asset. A battery task without an asset has nowhere to record history.
3. Insert `maintenance_occurrence` with `source='condition'`, `plan_id = NULL` (or the rule's shadow plan if one exists), `condition_episode_id`, `condition_rule_id`, `asset_id`, `title` from the template, `due_date = localDateOf(now, tz)`, `original_due_date` the same, `status='pending'`, priority/assignment from the rule, `procedure_version_id` resolved from `rule.procedure_id`.
   `ux_occ_open_per_condition` (on `condition_rule_id || ':' || asset_id`) is the dedupe: a device whose battery dips, recovers, and dips again while the first task is still open produces **no second task** — it reuses the open one and appends an `occurrence_event`.
4. Pre-compute expected materials from `asset_consumable WHERE role='battery'` (e.g. 2 × AAA), else `rule.default_part_id`, quantity 1.
5. Phase 2 of the very next worker tick flips it `pending → due` and sends the notification at delivery time (or, if that has passed today, at the next tick subject to the send-window guard).

### 6.5 When the reading recovers

Recovery is **not** evidence that maintenance happened — someone may have jiggled the contacts, or the sensor may be warming up. Therefore:

1. `closeEpisode('recovered')`: `closed_at_ms`, `closed_value`.
2. The occurrence stays open, with `occurrence_event('condition_recovered', detail={value})`.
3. Reminders are **snoozed** for `recovery_snooze_days` (default 3) for both recipients — snoozed, deliberately not cleared, because clearing would imply "done". The next notification body reads *"Battery reading recovered (42 %) — did you replace it?"*.
4. The task page shows three explicit choices, and only the user picks:
   - **Record replacement** → normal completion flow, consumes the battery part;
   - **Close without maintenance** → `skip(reason='condition_recovered')`, no completion, no stock movement, honest history;
   - **Keep open**.
5. No auto-close. Ever. (A configurable `auto_close_days` exists but defaults to NULL/off.)
6. If the entity disappears from the registry, the episode closes with `close_reason='entity_removed'` and the occurrence is *not* closed — it gets an `app_alert('ha_link_missing')` instead. Telemetry vanishing is not maintenance either.

### 6.6 Battery replacement consumes a part

Completion flow, unchanged from §5 — the condition-derived occurrence has no plan materials, so expected materials come from `asset_consumable(role='battery')`:

- Smoke alarm `asset_consumable`: `part_id = part('AAA alkaline', tracking_mode='discrete', unit='pcs')`, `qty_milli = 2000` (= 2 pcs).
- The completion form pre-fills "AAA alkaline — 2 pcs", editable.
- Committing writes `stock_transaction(kind='consumption', reason='maintenance_consumption', qty_milli = -2000, completion_id, occurrence_id)`.
- `condition_episode.close_reason='completed'`, `closed_at_ms`, `occurrence_id` retained.
- Because this occurrence has no recurring plan, no next occurrence is generated — the next task arises the next time the battery actually goes low. (If the owner also wants a calendar "replace smoke alarm batteries every October" plan, that is an ordinary `fixed_monthly` plan on the same asset; the two coexist and both consume from the same part.)
- `allowQuickDone` is **true** here when 2 × AAA are in stock and unambiguous, so the notification can carry a real `Done` button. If stock is short, `Done` is replaced by `Complete…` (opens the reconciliation flow) — exactly the binding rule.

---

## 7. HA link and registry cache

### 7.1 Cache tables (identities only — no telemetry history)

**`ha_floor`** · `floor_id` TEXT PK · `name` · `level` INTEGER NULL · `icon` · `last_seen_ms` · `removed_at_ms` NULL.
**`ha_area`** · `area_id` TEXT PK · `name` · `floor_id` NULL → ha_floor · `icon` · `aliases_json` · `last_seen_ms` · `removed_at_ms` NULL.

**`ha_device`**

| column | type | null | notes |
|---|---|---|---|
| `device_id` | TEXT PK | no | HA device registry id |
| `name`, `name_by_user` | TEXT | yes | |
| `manufacturer`, `model`, `sw_version`, `hw_version` | TEXT | yes | |
| `area_id` | TEXT | yes | → ha_area |
| `via_device_id` | TEXT | yes | → ha_device (self) |
| `identifiers_json`, `connections_json` | TEXT | yes | for cross-restart identity matching |
| `entry_type` | TEXT | yes | `'service'` marks software "devices" |
| `disabled_by` | TEXT | yes | |
| `canonical_battery_entity_id` | TEXT | yes | → `ha_entity.registry_id` (§6.2) |
| `first_seen_ms`, `last_seen_ms` | INTEGER | no | |
| `removed_at_ms` | INTEGER | yes | soft delete — **never hard-delete**, links point here |

**`ha_entity`**

| column | type | null | notes |
|---|---|---|---|
| `registry_id` | TEXT PK | no | the **stable entity registry entry id** — the primary identity |
| `entity_id` | TEXT | no | renameable; UNIQUE partial `WHERE removed_at_ms IS NULL` |
| `unique_id` | TEXT | yes | integration-assigned |
| `platform` | TEXT | yes | integration domain |
| `config_entry_id` | TEXT | yes | |
| `device_id` | TEXT | yes | → ha_device |
| `area_id` | TEXT | yes | → ha_area (entity-level override) |
| `domain` | TEXT | no | derived from `entity_id` prefix |
| `device_class`, `original_device_class` | TEXT | yes | |
| `unit_of_measurement`, `state_class` | TEXT | yes | |
| `name`, `original_name` | TEXT | yes | |
| `entity_category` | TEXT | yes | `'diagnostic'`/`'config'` |
| `disabled_by`, `hidden_by` | TEXT | yes | |
| `first_seen_ms`, `last_seen_ms` | INTEGER | no | |
| `removed_at_ms` | INTEGER | yes | soft delete |

Unique: `(platform, unique_id)` partial `WHERE unique_id IS NOT NULL AND removed_at_ms IS NULL`. Indexes: `(device_id)`, `(device_class, unit_of_measurement)`, `(entity_id)`.

**`ha_entity_rename`** · `id` PK · `registry_id` → ha_entity · `old_entity_id`, `new_entity_id` · `detected_at_ms` · `source` `CHECK IN ('registry_sync','event')`.

**`ha_sync_run`** · `id` PK · `started_at_ms`, `finished_at_ms` · `status` `CHECK IN ('running','ok','failed')` · `devices_seen`, `entities_seen`, `areas_seen` INTEGER · `renames_detected`, `removals_detected`, `additions_detected` INTEGER · `error` TEXT NULL.
**`ha_connection_state`** · `id` TEXT PK `CHECK (id='ha')` · `connected` INTEGER · `connected_since_ms` NULL · `last_disconnected_at_ms` NULL · `last_error` TEXT · `ha_version` TEXT · `reconnect_attempts` INTEGER · `updated_at_ms`.

### 7.2 Identity, renames, removals, replacements

Identity precedence when matching a synced entity to a cached row: **`registry_id`** → **`(platform, unique_id)`** → `entity_id` (last resort, logged as weak).

- **Rename** (same `registry_id`, different `entity_id`): update `ha_entity.entity_id`, insert `ha_entity_rename`, refresh `asset_ha_link.entity_id_snapshot`, keep `link_state='active'`, and raise an informational `app_alert('ha_entity_renamed')` (auto-resolved after acknowledgement). **Nothing breaks**, because every link stores `registry_id` as the FK, never the `entity_id`.
- **Removal** (present in cache, absent from sync): set `ha_entity.removed_at_ms`; every referencing `asset_ha_link` → `link_state='missing'`; raise `app_alert('ha_link_missing')` naming the asset. Condition rules on that entity stop evaluating; any open episode closes with `close_reason='entity_removed'` (and the occurrence stays open, §6.5).
- **Replacement** (a new registry entry with the same `unique_id` on the same platform — typical when a device is re-paired): auto-suggest relinking. If exactly one `missing` link matches the new entry's `(platform, unique_id)` or `(device identifiers)`, present a one-click "relink" that repoints `asset_ha_link.ha_entity_registry_id`, sets `link_state='active'`, and writes `audit_log('ha_link_repaired')`. Never automatic — relinking asserts a physical identity claim that only the owner can make.
- **Software devices**: `ha_device.entry_type='service'` maps to `asset.is_virtual=1` and is allowed to have no `location_id`.
- **Assets with no HA representation** are the normal case: `asset_ha_link` is simply empty. Nothing in the maintenance engine requires an HA link.

Sync cadence: full registry sync on worker start, on HA reconnect, on `device_registry_updated`/`entity_registry_updated` events, and hourly as a safety net. Each run writes an `ha_sync_run` row.

### 7.3 HA areas/floors → model rooms/zones

`location_mapping` (§1.4) holds the mapping, with `source='suggested'|'confirmed'|'rejected'`. Suggestions come from:
1. exact normalised name match (`"Kitchen"` ↔ `location.name`/`slug`/`model_node.name` for `r-g-kitchen`) → confidence 1.0;
2. trigram similarity ≥ 0.7 → confidence = similarity;
3. HA floor name ↔ `location(kind='floor')` name, then areas constrained to that floor's rooms (a two-level match beats a flat one);
4. the HA area of a device already linked to an asset whose `location_id` is known → confidence 0.9 with `match_reason='via_linked_asset'`.

Suggestions are never auto-confirmed. A confirmed mapping is used for: defaulting `asset.location_id` when a new HA device appears, grouping the 3D view by HA area, and export enrichment.

---

## 8. Model revision and reconciliation

### 8.1 Principles

1. Every spatial record stores `model_revision_id` **and** the semantic `model_node_id` (**and** metres coordinates where relevant). The revision pointer is what makes a stale id detectable rather than mysterious.
2. Importing a new revision **never silently rewrites** records. It produces a reconciliation *plan* that a human accepts.
3. Records whose node id no longer exists keep pointing at their old revision and are flagged `needs_reconciliation=1`. They remain fully usable (the task list does not care about geometry); only the 3D view shows them as "unplaced".
4. Accepted decisions are remembered in `model_node_alias` so the next import follows them automatically.
5. Exploded/cutaway view transforms are never persisted (§1.5).

Tables with `model_revision_id` + `model_node_id` + `needs_reconciliation`: `location`, `asset_placement`, `infra_route`, `infra_route_point`, `infra_endpoint`, `annotation`, `storage_place`.

### 8.2 Reconciliation tables

**`model_reconciliation`** · `id` PK · `from_revision_id` → revision · `to_revision_id` → revision · `status` TEXT `CHECK IN ('open','applied','abandoned')` · `created_at_ms`, `created_by` · `applied_at_ms`, `applied_by` NULL · `summary_json` TEXT (counts by outcome).
Partial unique: `UNIQUE (to_revision_id) WHERE status='open'`.

**`model_reconciliation_item`**

| column | type | null | notes |
|---|---|---|---|
| `id` | TEXT PK | no | |
| `reconciliation_id` | TEXT | no | → model_reconciliation CASCADE |
| `entity_kind` | TEXT | no | `CHECK IN ('location','asset_placement','infra_route','infra_route_point','infra_endpoint','annotation','storage_place')` |
| `entity_id` | TEXT | no | |
| `old_node_id` | TEXT | no | |
| `issue` | TEXT | no | `CHECK IN ('node_missing','kind_changed','moved_beyond_tolerance','parent_changed','duplicate_node')` |
| `candidates_json` | TEXT | yes | `[{nodeId,name,kind,score,reason,centroidDistanceM}]` |
| `proposed_action` | TEXT | no | `CHECK IN ('remap','keep','archive','none')` |
| `proposed_new_node_id` | TEXT | yes | |
| `decision` | TEXT | yes | `CHECK IN (NULL,'remap','keep','archive')` |
| `decided_new_node_id` | TEXT | yes | |
| `decided_by`, `decided_at_ms` | | yes | |
| `note` | TEXT | yes | |

Unique: `(reconciliation_id, entity_kind, entity_id, old_node_id)`.

### 8.3 Import and diff algorithm

```
importRevision(pkg):
  hash = sha256(canonical(pkg.nodes + pkg.manifest))
  if exists model_revision(model_id, hash): return existing (no-op import — idempotent)
  B = insert model_revision(status='imported'); insert model_node rows for B

  A = current revision for model_id
  if !A: mark B 'current'; return { firstImport: true }

  // 1) referenced ids
  refs = SELECT DISTINCT entity_kind, entity_id, model_node_id
           FROM (union of the 7 spatial tables) WHERE model_revision_id = A.id

  rec = insert model_reconciliation(A -> B, status='open')
  for r in refs:
     alias = model_node_alias(model_id, from=A, to=B, old_node_id=r.model_node_id)
     nodeB = alias?.new_node_id ? B.node(alias.new_node_id) : B.node(r.model_node_id)

     if nodeB and nodeB.kind == A.node(r.model_node_id).kind:
        dist = distance(A.node.centroid, nodeB.centroid)
        if dist <= 0.5 m:  auto-carry: set record.model_revision_id = B (+ alias node id), needs_reconciliation = 0
        else:              item(issue='moved_beyond_tolerance', proposed='remap' to same id, candidates=[nodeB])
     else if nodeB and kind changed:
        item(issue='kind_changed', candidates=[nodeB], proposed='keep')
     else:
        cands = rank B nodes by: same kind (+0.4), name similarity (+0.4×sim),
                                 centroid distance (+0.2×(1 - min(dist,10)/10)),
                                 same parent path (+0.1)
        item(issue='node_missing', candidates=top 5,
             proposed = cands[0].score >= 0.75 ? 'remap' : 'none')
        set record.needs_reconciliation = 1

  // 2) also record nodes newly appearing (informational, for "place this asset" prompts)
  rec.summary_json = counts
  if rec has zero items: apply(rec); mark B 'current'
  else: raise app_alert('model_reconciliation'); B stays 'imported' until applied
```

Auto-carry (unchanged id, unchanged kind, centroid within 0.5 m) covers the overwhelmingly common case — a re-export with new geometry but the same semantic ids — and requires no human input. Everything else waits.

**Applying:** in one `IMMEDIATE` transaction, per item decision — `remap`: set `model_node_id = decided_new_node_id`, `model_revision_id = B`, `needs_reconciliation = 0`, insert `model_node_alias`, and re-project the position (if the record has one) by the centroid delta, flagging positions that move > 2 m for review; `keep`: leave `model_node_id`, set `model_revision_id = B`, `needs_reconciliation = 1`, alias with `new_node_id = old_node_id` so the next import does not re-ask; `archive`: for `asset_placement`/`annotation`/`infra_*`, set a `archived_at_ms` (soft delete) — the owning domain record (`asset`, etc.) is untouched, so maintenance history survives a geometry purge; `location` rows are never archived automatically (they anchor everything) — they can only be `remap` or `keep`.
Then `A.status='superseded'`, `B.status='current'`, `household_setting.current_model_revision_id = B.id`, `model_reconciliation.status='applied'`, plus one `audit_log('model_reconciled')` per item.

**Orphan detection outside imports:** a nightly job counts records with `needs_reconciliation=1` or whose `(model_revision_id, model_node_id)` has no `model_node` row, and refreshes `app_alert('model_reconciliation')` with the count.

### 8.4 Exports and coordinate-system context

Every export carries the frame so coordinates are interpretable years later:

```json
{
  "exportedAt": "2026-09-08T09:00:00.000Z",
  "app": { "name": "virtual-home", "schemaVersion": 14 },
  "household": { "timezone": "Europe/Helsinki", "deliveryTime": "09:00" },
  "model": {
    "modelId": "example-house-1",
    "revisionId": "0193…",
    "schemaVersion": "3.1",
    "generatedAt": "2026-06-02T11:04:00.000Z",
    "contentHash": "sha256:…",
    "coordinateSystem": { "units": "m", "up": "y", "forward": "-z", "origin": "model-frame" }
  },
  "datasets": { "assets": [ … ], "completions": [ … ], "stockTransactions": [ … ] }
}
```

Datasets: `assets`, `locations`, `systems`, `plans`, `occurrences`, `completions` (+ materials inline), `parts`, `stockTransactions`, `infraRoutes` (+ points inline), `annotations`, `projects`, `serviceDocuments`, `haLinks`.
CSV mode: one file per dataset plus `_manifest.csv` and `_context.json` (the envelope above). Conventions: instants as ISO-8601 UTC **plus** a companion `*_local_date` column; quantities as decimal (`qty = qty_milli / 1000`) with a `unit` column; coordinates as `pos_x`/`pos_y`/`pos_z` with `model_node_id` and `model_revision_id` beside them; `NULL` as empty, never `"null"`.

---

## 9. Automated test plan (prioritised, fake clock everywhere)

All tests inject `Clock`, `tz`, and an in-memory SQLite (`:memory:`) built by the real migrations, so the schema under test is the shipped schema. No test reads the system clock or the real TZ database default.

### P0 — recurrence and calendar correctness (`domain/recurrence.test.ts`)

1. `interval_from_completion` 6 months, completion 2026-09-08 → 2027-03-08.
2. Late completion re-anchors: 6-month interval, due 2026-03-01, completed 2026-08-20 → next 2027-02-20 (not 2026-09-01).
3. Early completion re-anchors earlier: due 2026-06-01, completed 2026-05-10 → 2026-11-10.
4. Backdated completion yields an immediately-overdue next occurrence (no silent roll-forward).
5. `fixed_monthly [4,10] day 1`: prev due 2026-04-01, completed 2026-04-20 → 2026-10-01 (**not** 2027-04-01) — completion date does not move a calendar series.
6. Same rule, completed 2026-12-05 → 2027-04-01 with `missedSeriesDates == ['2026-10-01']` and an `audit_log` entry.
7. `fixed_monthly [1..12] day 31`: 2026-01-31 → 2026-02-28 → 2026-03-31 (clamp does not advance or drift).
8. `fixed_monthly` `dayOfMonth:'last'`: 2026-01-31 → 2026-02-28 → 2026-03-31 → 2026-04-30.
9. `fixed_interval` every 1 month from anchor 2026-01-31: 02-28, 03-31, 04-30, 05-31 — asserts the anchor+k computation, i.e. **no** 28→28→28 drift.
10. Leap year: `fixed_yearly` Feb 29 rule rejected by validation; `fixed_interval` 1 year from 2028-02-29 → 2029-02-28.
11. `interval_from_completion` 1 month from 2026-08-31 ×6 → 2027-02-28 (via a single 6-month step, and via six 1-month steps, asserting the two differ and documenting why).
12. `seasonal_window` 1 May–30 Jun: prev 2026-05-01, completed 2026-06-12 → due 2027-05-01, window fields set.
13. Seasonal window not completed inside the window: occurrence remains open past 2027-06-30, weekly reminders continue, completion on 2027-08-02 closes 2027 and yields 2028-05-01.
14. Seasonal window spanning New Year (15 Nov–15 Feb): window end year = start year + 1; next due 2027-11-15.
15. `fixed_weekly` `[6]` every 2 weeks, anchor 2027-01-02 → 2027-01-16 (parity respected).
16. Seeding matrix: each of the six rows in §2.4 produces the stated `schedule_anchor_source`, `due_date`, and — critically — **zero `completion` rows**.
17. `'ask'` seeding creates no occurrence and leaves the plan `paused` with an alert.

### P0 — DST and instant computation (`domain/time.test.ts`)

18. `instantOf('2027-03-21','09:00','Europe/Helsinki') === Date.parse('2027-03-21T07:00:00Z')`.
19. `instantOf('2027-03-28','09:00',…) === …T06:00:00Z` — spring forward, wall clock preserved.
20. `instantOf('2027-10-31','09:00',…) === …T07:00:00Z` — fall back, wall clock preserved.
21. Weekly slot series across 2027-03-28: gaps are 6 d 23 h then 7 d, and every local time is exactly 09:00.
22. Weekly slot series across 2027-10-31: gaps are 7 d 1 h then 7 d, all at 09:00 local.
23. Nonexistent local time: delivery time `03:30` on 2027-03-28 resolves to 04:00 local (first valid instant).
24. Ambiguous local time: delivery time `03:30` on 2027-10-31 resolves to the **earlier** (EEST) instant.
25. Slot instants are never computed by `+7*86400000` — a property test over 400 consecutive due dates asserts `localTimeOf(t(n)) === deliveryTime` for every `n`.

### P0 — occurrence lifecycle (`domain/occurrence.test.ts`)

26. `pending → due` fires exactly at `instantOf(due_date, '09:00', tz)` and not one tick earlier.
27. One-open-occurrence invariant: completing generates exactly one successor; a forced second insert violates `ux_occ_open_per_plan`.
28. Postpone moves `due_date`, preserves `original_due_date`, re-anchors the reminder series to the new date, and does **not** touch `plan.schedule_anchor_date` or `recurrence_json`.
29. Snooze changes neither `due_date` nor plan anchor, writes no `completion` and no `stock_transaction`, and only affects the snoozing recipient (the other user's next slot is unchanged).
30. Skip closes without a completion, generates the next occurrence with `schedule_anchor_source='skipped_due_date'`, and leaves `plan.last_completion_id` untouched.
31. Cancel plan closes the open occurrence, clears both recipients, and generates nothing.
32. Block/unblock leave `due_date` and the slot series unchanged; "block + snooze" performs both effects.
33. Booking a professional does not complete the occurrence; `status='attended'` still does not.
34. Reopen after skip cancels an untouched successor; reopen is **refused** when the successor has progress rows.
35. Guided-procedure progress survives a simulated process restart and resumes at the first not-done step.

### P0 — completion and stock atomicity (`domain/completion.test.ts`)

36. Happy path: one completion, one consumption transaction, correct balance, occurrence closed, successor created, both recipients cleared, two `clear` commands enqueued — all visible in one commit.
37. Same `completionRequestId` twice → second call returns the first completion; **exactly one** stock transaction exists.
38. Two different `completionRequestId`s concurrently (both transactions interleaved against the same DB) → one succeeds, the other throws `ConflictError`; exactly one consumption, exactly one successor.
39. Notification `Done` action delivered twice by HA → `notification_action_event` records `duplicate`, and `completion.request_id='act:'+nonce` guarantees one completion and one deduction.
40. Insufficient stock with no `resolutionIfShort` → transaction rolls back entirely (no completion, no transactions) and the error enumerates the three options.
41. `adjust_up`: adjustment + consumption both written, net balance 0, `stock_resolution='adjusted_up'`, `audit_log` entry present.
42. `consume_available`: consumption equals available, `shortfall_milli` correct, completion preserved.
43. `note_discrepancy`: balance goes negative, `app_alert('negative_stock')` raised, completion preserved.
44. A failure injected at step 10 (successor generation) rolls back the completion **and** the stock transactions — nothing partial.
45. Void completion: reversing transactions restore the balance exactly, originals untouched, untouched successor cancelled, occurrence reopened, `plan.last_completion_id` reverted to the previous completion.
46. Void is idempotent; double-reversal is blocked by `UNIQUE(reverses_transaction_id)`.
47. Quantity correction writes a `correction` transaction (delta only) and does not mutate the original consumption row.
48. Kit explode: `-1 kit`, `+N components`, one `transaction_group_id`; `available(component)` counts components only and `available(kit)` counts kits only — a test asserts the sum is **not** double counted; undo-explode restores both balances.
49. `estimated` tracking: setting an open lot to 40 % writes an `estimate_update` transaction whose delta matches, and the ledger sum equals the displayed remaining.
50. Equipment replacement: new `asset` row created, `replaces`/`replaced_by` set both ways, old asset `removed`, `asset_replacement` row present, the completion's `asset_id` snapshot is the **old** asset, active plans repointed to the new asset, past completions untouched, next due = completion + 6 months.

### P0 — notification engine (`domain/notify.test.ts`)

51. Due-date notification fires once, at delivery time, with `slot_index=0`; no advance reminder exists at any earlier tick.
52. Shared assignment produces two recipient states, two tags, two commands; user-specific produces one.
53. Weekly cadence: slots at due, due+7, due+14, due+21, each at 09:00 local, each sent once; ticking 1440 times between slots produces no extra sends.
54. Completion at day 10 clears both recipients immediately: pending slots cancelled, two `clear` commands with the right tags, and no further sends over the following 100 simulated days.
55. **Restart catch-up**: down 4 Jan → 3 Feb 12:00 → exactly **one** notification per recipient, `slot_index=4`, `consolidated_count=5`, next slot 8 Feb — anchored to the original due date (the §4.5 worked example, asserted field by field).
56. Catch-up outside the send window (restart at 03:00 local) holds the slot until 08:00 and then sends once.
57. Digest: 6 overdue occurrences for one recipient after an outage → one digest command, all six slots advanced and marked `sent_via='digest'`, no per-task pushes.
58. Two workers ticking against the same DB: exactly one `ha_notify_command` per (slot, device); the loser's claim fails on `changes !== 1`; the fence check blocks the loser from finalising.
59. Worker killed after claiming and before sending: the claim expires and the next tick re-claims and sends **once** (attempt log shows two attempts, one accepted).
60. HA disconnected: attempts recorded `ha_unavailable` with growing backoff, slot stays pending, no `sent_at_ms`; on reconnect the command sends once and the next slot is created.
61. A completion during an HA outage enqueues clears that survive the outage and drain **before** any queued notify on reconnect.
62. HA accepts the call → `state='sent'`, `sent_at_ms` set; the test asserts no code path ever writes a `delivered` field (there isn't one).
63. Tag stability: `slot_index` 0..5 for the same (occurrence, recipient) all carry the identical tag.
64. `allow_quick_done` matrix: `Done` offered when materials are unambiguous and in stock; replaced by `Complete…` when a checklist item requires a value, when stock is short, or when the plan requires a professional.
65. Action validation: unknown nonce, expired nonce (> 30 days), wrong `recipientUserId`, an action not present in `offered_actions_json`, a closed occurrence, and a device belonging to the other user — each recorded with the right `validation` value and `applied_effect='noop'`.
66. Snooze via action moves only that recipient's next slot to tomorrow 09:00 local, keeps `slot_index`, and after that fire the series resumes at `t(index+1)` from the **original** anchor.
67. Postpone re-anchors: recipient states get the new `anchor_date` and `slot_index=0`, and the old pending slot is cancelled.
68. Missing notify device: slot → `failed`, `app_alert('notify_device_missing')`, and no crash of the tick.

### P1 — low battery (`domain/condition.test.ts`)

69. 12 % sustained 2 h with threshold 15 % → one episode, one occurrence, `due_date = today`, notification at delivery time.
70. 12 % for 30 min then 40 % → **no** episode (sustain not met).
71. `unavailable` / `unknown` / `''` / `"AAA"` are never treated as 0 %: no episode opens, `is_valid=0`, `invalid_reason` correct.
72. A 5-minute `unavailable` blip inside an open low run does not reset `below_since_ms` (the episode still opens on schedule).
73. A reading with `last_updated_ms` 3 days old (threshold 48 h) opens nothing and raises `app_alert('stale_sensor')`.
74. Dead band: oscillation 14/16/13/17/14 after an episode has opened neither closes nor re-opens anything.
75. Recovery to 45 % sustained 6 h closes the episode, keeps the occurrence open, snoozes both recipients 3 days, writes `occurrence_event('condition_recovered')`, and **does not** create a completion.
76. "Close without maintenance" after recovery → `skip(reason='condition_recovered')`, no completion, no stock movement.
77. Entity dedupe: a device exposing `sensor.x_battery` (%, `battery`), `sensor.x_battery_voltage` (V, `voltage`) and `sensor.x_battery_type` (`"AAA"`) yields exactly **one** canonical entity, the `%` one; a manual `asset_ha_link(role='battery_level')` overrides the ranking.
78. Dip → recover → dip while the first occurrence is still open creates **no** second occurrence (`ux_occ_open_per_condition`), only an extra event.
79. Battery completion consumes 2 × AAA from `asset_consumable` and closes the episode with `close_reason='completed'`.
80. Entity removed from the registry: episode closes `entity_removed`, occurrence stays open, `app_alert('ha_link_missing')` raised, links `link_state='missing'`.

### P1 — HA registry (`integration/haRegistry.test.ts`)

81. Rename (`sensor.a` → `sensor.b`, same `registry_id`) keeps the link `active`, updates the snapshot, and records `ha_entity_rename`; the condition rule keeps evaluating.
82. Re-pairing (new `registry_id`, same `platform`+`unique_id`) produces a relink **suggestion**, never an automatic relink.
83. Removal soft-deletes and sets links `missing`; a later re-appearance restores rather than duplicating.
84. `entry_type='service'` devices map to `asset.is_virtual=1` and are allowed a NULL `location_id`.
85. Area/floor suggestions: exact name match → confidence 1.0 `suggested`; a fuzzy match at 0.72 → `suggested`; nothing is ever written as `confirmed` without a user decision.
86. Reconnect triggers a full sync and one `ha_sync_run` row with correct counters.

### P1 — model reconciliation (`domain/model.test.ts`)

87. Re-import of the identical package (same hash) is a no-op.
88. New revision, all node ids unchanged, centroids within 0.5 m → auto-carry, zero reconciliation items, revision becomes `current`.
89. `r-g-kitchen` renamed to `r-g-kitchen-main` → one `node_missing` item with the rename as the top candidate (score ≥ 0.75, `proposed_action='remap'`); the affected `asset_placement` is flagged and the revision does **not** become current until applied.
90. `keep` decision records an identity alias so a later import does not re-ask.
91. `archive` decision soft-deletes the placement and leaves the asset and all of its completion history intact.
92. A node whose centroid moved 4 m produces `moved_beyond_tolerance` and, on remap, re-projects the position and flags it for review.
93. Placement write rejected (422) when the request declares `viewMode: 'exploded'`; no table exists that could hold a temporary transform.
94. Orphan sweep counts records with `needs_reconciliation=1` and refreshes a single deduped alert.

### P2 — persistence, audit, exports

95. Migrations apply cleanly to an empty DB and are idempotent on re-run; the resulting schema matches `drizzle-kit generate` output byte-for-byte (drift test).
96. All pragmas are set on every connection in both processes; a test asserts `foreign_keys=1` and `journal_mode=wal`.
97. Concurrent writers: 50 interleaved write transactions from two connections all commit, none raise `SQLITE_BUSY` past the retry wrapper.
98. Every `CHECK` constraint has a negative test (bad enum value, negative quantity, `qty_milli=0`, both-null and both-non-null polymorphic guards).
99. `audit_log` receives exactly one row per meaningful transition (a fixture walks a plan through create → due → postpone → block → complete → void and asserts the exact event list, in order).
100. Actor attribution: worker-initiated rows have `actor_kind='worker'` and a NULL `actor_user_id`; user actions carry the real id.
101. JSON export round-trips: instants are ISO-8601 UTC, local dates are `YYYY-MM-DD`, quantities are decimal with a unit, and the envelope carries `modelId`, `revisionId`, and `coordinateSystem`.
102. CSV export: `_manifest.csv` lists every file with row counts; a spot-check row matches the DB.
103. `part_stock` view equals a naive per-part reduction over `stock_transaction` for a 5 000-transaction fixture (and runs in < 50 ms).

Test infrastructure to build first: `fakeClock(startIso)` with `advance(ms)` / `advanceToLocal('2027-03-28T09:00')`; `testDb()` running real migrations into `:memory:`; `fakeHa()` recording service calls with a settable `connected` flag and an `emit(event)` helper; `tickUntil(predicate, maxTicks)` driving the worker loop deterministically at 60 s per tick.

---

## 10. Open questions and risks

1. **Catch-up granularity.** I read "ONE consolidated catch-up reminder" as one per (occurrence, recipient), with a per-recipient digest above 3 tasks (§4.5.5). If the owner meant literally one push total after any outage, change `catchup_digest_threshold` to `1`. Worth confirming before implementation, since it changes the default UX after a week away.
2. **Blocked tasks keep reminding.** Binding policy 3 says remind every 7 days while incomplete, so blocking does not suppress reminders (the UI offers "block + snooze"). If "waiting for filters" should go quiet automatically, that is a one-line policy change but it contradicts the stated rule.
3. **`part_lot` complexity.** Lots exist for expiry/opened dates but every consumption then needs a lot choice. Default is `tracks_lots=0` for almost all parts; only enable it where expiry genuinely matters (sealants, filters with shelf life). Risk of the feature turning every completion into a picker if switched on broadly.
4. **Approximate anchors produce loud overdue numbers.** A `baseline_approx` anchor of "spring 2024" on a 6-month interval yields a task overdue by hundreds of days at first launch. Handled by labelling ("estimated"), but the initial import will look alarming; consider a one-time "start the clock today" bulk action at setup.
5. **`allow_quick_done` depends on live stock.** The `Done` button is decided at send time. Stock can change between send and tap, so a `Done` tap can still land in the reconciliation flow — in which case the action returns `applied_effect='noop'` with a deep link. This is correct but needs a clear in-app message.
6. **iOS notification tag semantics** (replace-in-place) are the mechanism behind "week 3 overwrites week 2" and the clear path. Worth a manual smoke test on both phones early; if the companion app version behaves differently, the engine still works but the notification tray gets noisier.
7. **Two processes, one SQLite file.** WAL plus `BEGIN IMMEDIATE` plus `busy_timeout` is sound for one writer at a time, and the worker is the main writer. If the web process ever grows a long-running write (a bulk import), it will block the tick for its duration. Mitigation: bulk operations chunk into transactions of ≤ 500 rows.
8. **Model package format.** The design assumes the package exposes a node list with stable ids, kinds, parents, centroids, and a manifest with `schemaVersion` + `generatedAt`. If centroids are absent, candidate ranking loses its distance term and reconciliation gets noticeably worse — worth verifying against the actual export before building §8.
9. **Attachment storage.** Files on disk, hashes in SQLite. Backups must cover both, and the two can drift (a restored DB pointing at missing files). A nightly integrity check comparing `attachment.sha256`/`storage_path` against disk should be on the build list; it is not designed above.
10. **`fixed_weekly` may be unnecessary.** It is in the rule union for completeness, but nothing in the requirements asks for weekly household tasks. If it is not needed, drop it — one fewer branch in `computeNextDue` and four fewer tests.

---

### Critical Files for Implementation

Files the implementing engineer should create first, in this order:

- `/Users/machadolucas/git/virtual-home/src/db/schema.ts` — the full Drizzle schema of §1 (all tables, checks, partial unique indexes), plus `/Users/machadolucas/git/virtual-home/src/db/connect.ts` for the pragma set and `BEGIN IMMEDIATE` transaction helper.
- `/Users/machadolucas/git/virtual-home/src/domain/time.ts` — `Clock`, `instantOf`, `localDateOf`, `addMonthsClamped`, and the DST gap/ambiguity rules of §0.1. Everything else depends on this being right.
- `/Users/machadolucas/git/virtual-home/src/domain/recurrence.ts` — `RecurrenceRule` type, Zod validator, and `computeNextDue` (§2).
- `/Users/machadolucas/git/virtual-home/src/domain/completion.ts` — the single-transaction completion/reconciliation/void/replacement service of §5, including `completionRequestId` idempotency and stock ledger writes.
- `/Users/machadolucas/git/virtual-home/src/worker/notificationTick.ts` — the lease/claim, slot materialisation, catch-up consolidation, send-window guard, and outbox drain of §4, plus `src/worker/haActionHandler.ts` for inbound action validation and replay protection.