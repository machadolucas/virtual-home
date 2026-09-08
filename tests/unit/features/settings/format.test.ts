/**
 * Formatters and the memory sparkline.
 *
 * The sparkline's contract is the interesting one: **one sample is not a trend.** Drawing a single
 * point as a flat line would imply a stability nobody observed, so it returns null and the page
 * says why. And the baseline is zero rather than the minimum, so two per cent of noise does not
 * render as a mountain range.
 */
import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatBytes,
  isoOf,
  memorySparkline,
  type MetricSample,
} from "@/features/settings/format";
import {
  contextTable,
  csvDocument,
  csvField,
  flattenContext,
  milliToDecimal,
} from "@/features/settings/csv";

const NOW = Date.parse("2026-09-08T09:00:00Z");

describe("formatBytes", () => {
  it("uses decimal units, as df and the backup log do", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(1536)).toBe("1.5 kB");
    expect(formatBytes(12_000_000)).toBe("12 MB");
    expect(formatBytes(3_500_000_000)).toBe("3.5 GB");
  });

  it("says unknown rather than inventing a number", () => {
    expect(formatBytes(-1)).toBe("unknown");
    expect(formatBytes(Number.NaN)).toBe("unknown");
  });
});

describe("formatAge", () => {
  it("returns null for a missing instant, so the caller picks the honest word", () => {
    expect(formatAge(null, NOW)).toBeNull();
  });

  it("uses coarse buckets", () => {
    expect(formatAge(NOW - 5_000, NOW)).toBe("just now");
    expect(formatAge(NOW - 4 * 60_000, NOW)).toBe("4 min ago");
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(formatAge(NOW - 5 * 86_400_000, NOW)).toBe("5 days ago");
  });

  it("does not pretend a future timestamp is recent", () => {
    expect(formatAge(NOW + 60_000, NOW)).toBe("in the future");
  });
});

describe("isoOf", () => {
  it("is ISO-8601 UTC, or nothing", () => {
    expect(isoOf(NOW)).toBe("2026-09-08T09:00:00.000Z");
    expect(isoOf(null)).toBeNull();
  });
});

describe("memorySparkline", () => {
  const samples: MetricSample[] = [
    { atMs: NOW - 3_600_000, rssBytes: 100_000_000 },
    { atMs: NOW - 1_800_000, rssBytes: 150_000_000 },
    { atMs: NOW, rssBytes: 120_000_000 },
  ];

  it("refuses to draw a trend from fewer than two samples", () => {
    expect(memorySparkline([], 100, 10)).toBeNull();
    expect(memorySparkline([samples[0]!], 100, 10)).toBeNull();
  });

  it("spans the full width and reports the peak and the latest", () => {
    const line = memorySparkline(samples, 600, 60);
    expect(line).not.toBeNull();
    expect(line?.sampleCount).toBe(3);
    expect(line?.peakBytes).toBe(150_000_000);
    expect(line?.lastBytes).toBe(120_000_000);
    const points = (line?.points ?? "").split(" ").map((pair) => pair.split(",").map(Number));
    expect(points[0]?.[0]).toBe(0);
    expect(points[points.length - 1]?.[0]).toBe(600);
  });

  it("baselines at zero, so the peak touches the top and nothing touches the bottom", () => {
    const line = memorySparkline(samples, 600, 60);
    const ys = (line?.points ?? "").split(" ").map((pair) => Number(pair.split(",")[1]));
    // The peak maps to y = 0 (SVG's top); the smallest sample is well above the floor because the
    // scale starts at zero rather than at the minimum.
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBeLessThan(60);
  });

  it("survives every sample being identical", () => {
    const flat = memorySparkline(
      [
        { atMs: NOW - 1000, rssBytes: 100 },
        { atMs: NOW, rssBytes: 100 },
      ],
      100,
      10,
    );
    expect(flat?.points).toBe("0.0,0.0 100.0,0.0");
  });

  it("survives two samples at the same instant without dividing by zero", () => {
    const line = memorySparkline(
      [
        { atMs: NOW, rssBytes: 100 },
        { atMs: NOW, rssBytes: 200 },
      ],
      100,
      10,
    );
    expect(line?.points).not.toContain("NaN");
  });
});

describe("csv serialisation", () => {
  it("quotes only what needs quoting", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("has,comma")).toBe('"has,comma"');
    expect(csvField('has"quote')).toBe('"has""quote"');
    expect(csvField("has\nnewline")).toBe('"has\nnewline"');
  });

  it("writes NULL as an empty field, never the four letters", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("neutralises a leading character Excel would treat as a formula", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+41 40 123")).toBe("'+41 40 123");
    expect(csvField("-notes")).toBe("'-notes");
    expect(csvField("@handle")).toBe("'@handle");
  });

  it("writes booleans as words", () => {
    expect(csvField(true)).toBe("true");
    expect(csvField(false)).toBe("false");
  });

  it("emits a BOM and CRLF, because the likely reader is Excel", () => {
    const document = csvDocument({ columns: ["a", "b"], rows: [[1, "x"]] });
    expect(document.startsWith("﻿")).toBe(true);
    expect(document).toContain("\r\n");
  });

  it("separates sections with a blank line", () => {
    const document = csvDocument(
      contextTable({ "model.modelId": "house-8a" }),
      { columns: ["part_id"], rows: [["p1"]] },
    );
    const lines = document.replace("﻿", "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("context_key,context_value");
    expect(lines[1]).toBe("model.modelId,house-8a");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("part_id");
  });

  it("gives every quantity a decimal companion", () => {
    expect(milliToDecimal(2000)).toBe(2);
    expect(milliToDecimal(750)).toBe(0.75);
    expect(milliToDecimal(null)).toBeNull();
  });

  it("flattens the envelope into dotted keys", () => {
    const flat = flattenContext({
      app: { name: "virtual-home", schemaVersion: 1 },
      model: { coordinateSystem: { units: "m", upAxis: "y" } },
      datasetNames: ["parts", "lots"],
      nothing: null,
    });
    expect(flat["app.name"]).toBe("virtual-home");
    expect(flat["app.schemaVersion"]).toBe(1);
    expect(flat["model.coordinateSystem.units"]).toBe("m");
    expect(flat["datasetNames"]).toBe("parts lots");
    expect(flat["nothing"]).toBeNull();
  });
});
