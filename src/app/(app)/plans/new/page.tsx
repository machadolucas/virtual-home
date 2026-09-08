import type { Metadata } from "next";
import { requireSessionPage } from "@/server/auth/session";
import { PageHeader, PageScroll } from "@/ui/shell";
import { PlanForm } from "@/features/maintenance/PlanForm";
import { loadMembers, maintenanceContext } from "@/server/queries/maintenance/context";
import { loadProcedureOptions, loadProviders, searchParts } from "@/server/queries/maintenance/plans";
import { searchTargets } from "@/server/queries/maintenance/targets";

export const metadata: Metadata = { title: "New plan" };

/**
 * A new maintenance plan.
 *
 * The pickers are handed the whole (small) lists rather than a search endpoint: this household has
 * tens of assets and tens of parts, and a round-trip per keystroke would be slower and more code
 * for no benefit.
 */
export default async function NewPlanPage() {
  const session = await requireSessionPage("/plans/new");
  const { db, today } = maintenanceContext(session.user.id);

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Maintenance plans"
        title="New plan"
        description="What needs doing, to what, how often — and, honestly, when it was last done."
      />
      <PlanForm
        mode="create"
        targets={searchTargets(db, "", 200)}
        procedures={loadProcedureOptions(db)}
        parts={searchParts(db, "", 200)}
        providers={loadProviders(db).map((provider) => ({
          value: provider.id,
          label: provider.name,
          hint: provider.trade ?? undefined,
        }))}
        members={loadMembers(db).map((member) => ({ id: member.id, name: member.name }))}
        today={today}
        anchorDate={null}
        askSetup
      />
    </PageScroll>
  );
}
