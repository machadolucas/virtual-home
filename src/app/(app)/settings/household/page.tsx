import type { Metadata } from "next";
import { requireSessionPage } from "@/server/auth/session";
import { PageHeader } from "@/ui/shell";
import { pageContext, readHouseBackground } from "@/server/queries/settings/household";
import { HouseholdForm, type HouseholdDraft } from "./HouseholdForm";
import { AppearancePanel } from "./AppearancePanel";

export const metadata: Metadata = { title: "Household" };

/**
 * `/settings/household` — every tunable the scheduler, the notifier and the inventory engine read
 * at runtime.
 *
 * They live in the database rather than in the environment on purpose: changing when reminders
 * arrive should not need a deploy, and each change is attributed. The one thing that is *not* here
 * is the Home Assistant token, which stays in the server environment where a browser cannot reach
 * it.
 */
export default async function HouseholdSettingsPage() {
  await requireSessionPage("/settings/household");
  const { db, household } = pageContext();
  const background = readHouseBackground(db);

  const initial: HouseholdDraft = {
    displayName: household.displayName,
    timezone: household.timezone,
    deliveryTime: household.deliveryTime,
    reminderIntervalDays: String(household.reminderIntervalDays),
    sendWindowStart: household.sendWindowStart,
    sendWindowEnd: household.sendWindowEnd,
    catchupGapMinutes: String(household.catchupGapMinutes),
    catchupDigestThreshold: String(household.catchupDigestThreshold),
    slotGraceMinutes: String(household.slotGraceMinutes),
    actionTtlDays: String(household.actionTtlDays),
    batteryThresholdPct: String(household.batteryThresholdPct),
    batteryClearPct: String(household.batteryClearPct),
    batterySustainMinutes: String(household.batterySustainMinutes),
    batteryClearSustainMinutes: String(household.batteryClearSustainMinutes),
    batteryStaleHours: String(household.batteryStaleHours),
    reorderHorizonDays: String(household.reorderHorizonDays),
    haBaseUrl: household.haBaseUrl,
    inventoryPushEnabled: household.inventoryPushEnabled,
  };

  // The full IANA list from the runtime, so the options can never drift from what `parseEnv` and
  // the CHECK on the column will accept.
  const timezones = Intl.supportedValuesOf("timeZone");

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Household"
        description="What decides when things happen: the time zone every date is measured in, when reminders arrive, when a battery reading becomes a task, and how far ahead the shopping list looks. All of it takes effect on the worker's next tick, with no restart."
      />
      <HouseholdForm initial={initial} timezones={timezones} />
      <AppearancePanel background={background} />
    </>
  );
}
