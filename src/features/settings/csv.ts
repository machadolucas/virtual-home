/**
 * CSV serialisation for the export routes. Pure, so the conventions are testable.
 *
 * The conventions come from `docs/design-notes/domain-scheduling-inventory.md` §8.4 and exist so a
 * file opened in five years is still interpretable:
 *  - instants as ISO-8601 UTC, **plus** a companion `*_local_date` column where the household
 *    calendar date is the meaningful one;
 *  - quantities as decimals (`qty = qty_milli / 1000`) with a `unit` column beside them;
 *  - `NULL` as an empty field, never the four letters `null`;
 *  - CRLF line endings and a leading UTF-8 BOM, because the most likely reader is Excel and
 *    without both it mangles Nordic characters and puts every row in one cell.
 */

export type CsvValue = string | number | boolean | null | undefined;

/**
 * Quote a field only when it needs it, and double any embedded quote.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote: those characters make Excel treat
 * the cell as a formula, which is both a rendering bug and a well-known injection vector for a file
 * somebody else opens.
 */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const raw = typeof value === "number" ? formatNumber(value) : value;
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(value);
}

export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvField).join(",");
}

export interface CsvTable {
  columns: readonly string[];
  rows: readonly (readonly CsvValue[])[];
}

/** BOM + CRLF-joined table. */
export function csvDocument(...sections: readonly CsvTable[]): string {
  const lines: string[] = [];
  for (const [index, section] of sections.entries()) {
    if (index > 0) lines.push("");
    lines.push(csvRow(section.columns));
    for (const row of section.rows) lines.push(csvRow(row));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** `2000` -> `2`, `750` -> `0.75`. The decimal companion to a `*_milli` column. */
export function milliToDecimal(qtyMilli: number | null | undefined): number | null {
  if (qtyMilli === null || qtyMilli === undefined) return null;
  return qtyMilli / 1000;
}

/** Epoch ms -> ISO-8601 UTC, or empty. */
export function isoUtc(atMs: number | null | undefined): string | null {
  if (atMs === null || atMs === undefined) return null;
  return new Date(atMs).toISOString();
}

/**
 * The `_context` block, rendered as a two-column key/value table.
 *
 * §8.4 specifies a separate `_context.json` beside the dataset files. One HTTP response is one
 * file, so the context leads the CSV instead of sitting next to it — same information, same
 * document, and a spreadsheet shows it as a readable header block above a blank row.
 */
export function contextTable(context: Record<string, CsvValue>): CsvTable {
  return {
    columns: ["context_key", "context_value"],
    rows: Object.entries(context).map(([key, value]) => [key, value] as const),
  };
}

/** Flatten a nested context object into dotted keys, for the CSV context block. */
export function flattenContext(
  source: unknown,
  prefix = "",
): Record<string, CsvValue> {
  const out: Record<string, CsvValue> = {};
  if (source === null || typeof source !== "object") {
    if (prefix !== "") out[prefix] = toCsvValue(source);
    return out;
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenContext(value, path));
    } else if (Array.isArray(value)) {
      out[path] = value.length === 0 ? "" : value.map((entry) => String(entry)).join(" ");
    } else {
      out[path] = toCsvValue(value);
    }
  }
  return out;
}

function toCsvValue(value: unknown): CsvValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}
