import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function invalidExports(source: string): string[] {
  const file = ts.createSourceFile("action.ts", source, ts.ScriptTarget.Latest, true);
  if (!file.statements.some(s => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use server")) return [];
  const invalid: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let initializer = declaration.initializer;
      while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
      const asyncFunction = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
      const actionFactory = initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && ["action", "freshAction", "bindOperation"].includes(initializer.expression.text);
      if (!asyncFunction && !actionFactory) invalid.push(declaration.name.getText(file));
    }
  }
  return invalid;
}

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("Next server action module boundaries", () => {
  it("detects exported constant arrays even with a const assertion", () => {
    expect(invalidExports('"use server"; export const PRESETS = ["tomorrow"] as const;')).toEqual(["PRESETS"]);
    expect(invalidExports('"use server"; export const save = action(schema, async () => ({}));')).toEqual([]);
  });
  it("exports only async functions or known async action factories", () => {
    const violations = files(path.resolve("src/server/actions")).flatMap(file =>
      invalidExports(fs.readFileSync(file, "utf8")).map(name => `${path.relative(process.cwd(), file)}: ${name}`));
    expect(violations).toEqual([]);
  });
});
