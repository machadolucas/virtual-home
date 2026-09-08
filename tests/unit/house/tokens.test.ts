/**
 * The regression guard for the defect this test file was written for: the whole 3D workspace once
 * ignored the design tokens and rendered light while the rest of the app was dark.
 *
 * Every other slice of the app already honours `src/app/globals.css`; `src/house/**` was the only
 * place with hardcoded palette utilities (`bg-white`, `border-neutral-300`, `text-neutral-500`,
 * `bg-sky-50`, …). One re-added `bg-white` on a panel is enough to bring the bug back one panel at a
 * time, and nothing else in the suite would notice — so this walks the whole tree and fails with the
 * exact file and line.
 *
 * The fix for a failure is never to add to `ALLOWED` — it is to use the token: `bg-surface`,
 * `border-line`, `text-ink-3`, `bg-accent-soft`, and so on. `docs/ux.md` §3 has the full mapping.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HOUSE_DIR = path.join(process.cwd(), "src", "house");

/**
 * Any Tailwind colour utility that names a palette colour instead of a token.
 *
 * The prefix list is every utility group that takes a colour; the colour list is Tailwind's default
 * palette plus `white`/`black`. Token names (`surface`, `ink-3`, `accent-soft`, `overdue`, …) are
 * absent from both, which is exactly why this can be a blanket rule rather than a curated one.
 */
const FORBIDDEN =
  /\b(bg|text|border|ring|fill|stroke|divide|placeholder|outline|shadow|from|to|via)-(white|black|neutral|gray|slate|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/g;

/**
 * Deliberate exceptions, each with the reason it is not a token.
 *
 * Empty, and it should stay that way. A colour that has to be literal belongs in
 * `src/house/scene/palette.ts` (which resolves the tokens at runtime) or in the model package's own
 * materials — not in a class name.
 */
const ALLOWED: ReadonlyArray<{ file: string; utility: string; why: string }> = [];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface Offence {
  file: string;
  line: number;
  utility: string;
  text: string;
}

function offences(): Offence[] {
  const found: Offence[] = [];
  for (const file of sourceFiles(HOUSE_DIR)) {
    const relative = path.relative(process.cwd(), file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const [i, text] of lines.entries()) {
      for (const match of text.matchAll(FORBIDDEN)) {
        const utility = match[0];
        if (ALLOWED.some((a) => a.file === relative && a.utility === utility)) continue;
        found.push({ file: relative, line: i + 1, utility, text: text.trim() });
      }
    }
  }
  return found;
}

describe("src/house honours the design tokens", () => {
  it("finds the files to check", () => {
    // A broken walk would make the real assertion below pass vacuously.
    expect(sourceFiles(HOUSE_DIR).length).toBeGreaterThan(50);
  });

  it("uses no hardcoded palette colour utilities", () => {
    const found = offences();
    const report = found
      .map((o) => `${o.file}:${o.line}  ${o.utility}\n    ${o.text}`)
      .join("\n");
    expect(
      found,
      found.length === 0
        ? ""
        : `${found.length} hardcoded colour utilit${found.length === 1 ? "y" : "ies"} in src/house.\n` +
            "Use the token instead (docs/ux.md §3): bg-surface / bg-surface-2 / bg-paper,\n" +
            "border-line / border-line-strong, text-ink / text-ink-2 / text-ink-3,\n" +
            "accent* for selection, due / overdue / ok / stale / unknown for status.\n\n" +
            report,
    ).toEqual([]);
  });

  it("keeps the allow-list justified", () => {
    // Every exception must say why. An entry with no reason is an unreviewed exception.
    for (const entry of ALLOWED) expect(entry.why.length).toBeGreaterThan(20);
  });
});
