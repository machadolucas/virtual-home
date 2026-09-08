/**
 * Column and CHECK helpers shared by the domain schema modules.
 *
 * Deliberately tiny: these only remove copy-paste of the audit quad and of enum CHECK spelling.
 * Anything table-specific stays written out in the table itself (CLAUDE.md: boring and explicit).
 *
 * NOT exported from `./index.ts` — the barrel is the Drizzle schema object and should contain
 * tables and views only.
 */
import { sql, type SQL } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

/**
 * An actor column (`created_by`, `updated_by`, `decided_by`, …). Nullable on purpose: the worker
 * and the HA inbound handler write rows with no user behind them. ON DELETE RESTRICT — actor
 * attribution is never silently lost (the household has two users; neither gets deleted).
 */
export function actor(name: string) {
  return text(name).references(() => user.id, { onDelete: "restrict" });
}

/** `created_at_ms` + `created_by` — for append-only tables that are never updated. */
export function createdPair() {
  return {
    createdAtMs: integer("created_at_ms").notNull(),
    createdBy: actor("created_by"),
  };
}

/** The full audit quad: `created_at_ms`, `created_by`, `updated_at_ms`, `updated_by`. */
export function auditQuad() {
  return {
    createdAtMs: integer("created_at_ms").notNull(),
    createdBy: actor("created_by"),
    updatedAtMs: integer("updated_at_ms").notNull(),
    updatedBy: actor("updated_by"),
  };
}

/**
 * `column IN ('a','b',…)` for an enum CHECK. Values are literals from this source tree, so
 * `sql.raw` is safe here and keeps the emitted SQL readable.
 *
 * Note the SQLite semantics we rely on: for a NULL column the expression is NULL, not false, so a
 * nullable enum column needs no extra `OR col IS NULL` term.
 */
export function oneOf(column: string, values: readonly string[]): SQL {
  return sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);
}

/** `column >= 0`. */
export function nonNegative(column: string): SQL {
  return sql.raw(`${column} >= 0`);
}

/** `column > 0`. */
export function positive(column: string): SQL {
  return sql.raw(`${column} > 0`);
}

/** GLOB pattern that accepts exactly `HH:MM` (24h). */
export function isLocalTime(column: string): SQL {
  return sql.raw(`${column} GLOB '[0-2][0-9]:[0-5][0-9]'`);
}

/** GLOB pattern that accepts exactly a lowercase `#rrggbb` colour. */
export function isHexColor(column: string): SQL {
  return sql.raw(`${column} GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'`);
}

/** `(a IS NOT NULL) + (b IS NOT NULL) + … = 1` — exactly one target column set. */
export function exactlyOne(...columns: string[]): SQL {
  return sql.raw(`${columns.map((c) => `(${c} IS NOT NULL)`).join(" + ")} = 1`);
}
