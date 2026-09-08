"use client";
import type { Issue } from "@/house/model/types";

/**
 * The model producer's own recorded uncertainty, shown in context.
 *
 * This is why the garage's inspector says "±0.5 m / ±2°": an equipment position recorded there
 * inherits that uncertainty, and the household should know before trusting it.
 */
export function IssueList({ issues }: { issues: readonly Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <section className="rounded-md border border-amber-200 bg-amber-50 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">
        Recorded uncertainty
      </h3>
      <ul className="mt-1 space-y-1 text-xs text-amber-900">
        {issues.map((issue) => (
          <li key={issue.id}>
            <span className="font-mono text-[10px] opacity-70">
              {issue.id} · {issue.severity}
            </span>{" "}
            {issue.description}
          </li>
        ))}
      </ul>
    </section>
  );
}
