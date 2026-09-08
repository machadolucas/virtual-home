"use client";
/**
 * The three choices a recovered condition task offers (§6.5, step 4).
 *
 * A battery reading climbing back up is not evidence that anybody replaced anything — someone may
 * have jiggled the contacts, or the sensor may have warmed up. So the app closes the *episode*,
 * snoozes the reminders (rather than clearing them, which would imply "done") and then asks. There
 * is no auto-close, and "Keep open" is a real answer that does nothing at all.
 */
import { useState } from "react";
import { BatteryCharging, CircleSlash } from "lucide-react";
import { Button, Dialog, Panel } from "@/ui";
import { closeConditionWithoutMaintenance } from "@/server/actions/maintenance/condition";
import { messageFor, newRequestKey, useAction } from "./useAction";
import {
  CompleteDialog,
  type CompleteDialogMember,
  type CompleteDialogProvider,
} from "./CompleteDialog";
import type { MaterialLine } from "./materials";

export interface ConditionChoicesProps {
  occurrenceId: string;
  /** The reading that opened the episode, and the latest valid one. */
  openedValue: number | null;
  latestValue: number | null;
  latestValid: boolean;
  entityId: string | null;
  /**
   * Everything the completion dialog needs: "Record a replacement" is not a special path, it is
   * the ordinary completion flow, which is what makes the battery part leave stock (§6.6).
   */
  complete: {
    title: string;
    dueDate: string;
    today: string;
    viewerId: string;
    members: readonly CompleteDialogMember[];
    providers: readonly CompleteDialogProvider[];
    materials: readonly MaterialLine[];
    estimatedMinutes: number | null;
    assetName: string | null;
  };
}

export function ConditionChoices({
  occurrenceId,
  openedValue,
  latestValue,
  latestValid,
  entityId,
  complete,
}: ConditionChoicesProps) {
  const [confirming, setConfirming] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [key] = useState(newRequestKey);
  const { run, pending, failure } = useAction(closeConditionWithoutMaintenance, {
    success: "Closed without maintenance. No completion was recorded.",
    onDone: () => setConfirming(false),
  });

  return (
    <Panel
      title="The reading came back"
      subtitle="Recovering is not proof that maintenance happened, so this task is still open and only you can close it."
    >
      <div className="flex flex-col gap-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-3">When the alert opened</dt>
            <dd className="vh-tnum text-ink">
              {openedValue === null ? "Not recorded" : `${openedValue} %`}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">Latest reading</dt>
            <dd className="vh-tnum text-ink">
              {latestValid && latestValue !== null ? `${latestValue} %` : "No usable reading"}
            </dd>
          </div>
          {entityId !== null ? (
            <div className="sm:col-span-2">
              <dt className="text-ink-3">Home Assistant entity</dt>
              <dd className="font-mono text-xs text-ink-2">{entityId}</dd>
            </div>
          ) : null}
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<BatteryCharging aria-hidden="true" />}
            onClick={() => setCompleting(true)}
          >
            Record a replacement
          </Button>
          <Button
            variant="secondary"
            icon={<CircleSlash aria-hidden="true" />}
            onClick={() => setConfirming(true)}
          >
            Close without maintenance
          </Button>
        </div>
        <p className="text-sm text-ink-3">
          Or leave it open — nothing happens, and the reminders resume after the snooze runs out.
        </p>

        {completing ? (
          <CompleteDialog
            open
            onOpenChange={setCompleting}
            occurrenceId={occurrenceId}
            title={complete.title}
            dueDate={complete.dueDate}
            today={complete.today}
            viewerId={complete.viewerId}
            members={complete.members}
            providers={complete.providers}
            materials={complete.materials}
            estimatedMinutes={complete.estimatedMinutes}
            assetName={complete.assetName}
            isConditionTask
          />
        ) : null}

        <Dialog
          open={confirming}
          onOpenChange={setConfirming}
          size="sm"
          title="Close without maintenance"
          description="Closes the task with no completion, no stock movement and no claim that anything was replaced. History will show it was closed because the reading recovered."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() => void run({ occurrenceId, idempotencyKey: key })}
              >
                Close it
              </Button>
            </>
          }
        >
          {failure !== null ? (
            <p className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
              {messageFor(failure)}
            </p>
          ) : (
            <p className="text-sm text-ink-2">
              If a battery really was replaced, use “Record a replacement” instead so the part
              leaves stock and the next alert is measured from the right date.
            </p>
          )}
        </Dialog>
      </div>
    </Panel>
  );
}
