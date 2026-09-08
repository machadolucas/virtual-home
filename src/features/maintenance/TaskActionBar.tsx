"use client";
/**
 * The task page's action bar — sticky at the bottom of the page on a phone, where a thumb is.
 *
 * Ordering is deliberate: **Complete…** is the primary action and everything that avoids doing the
 * work sits behind it. "Complete…" opens a dialog rather than committing, because a completion asks
 * who did it, when, and what was used — a one-tap "done" is how fake history gets written.
 */
import { useState } from "react";
import {
  Ban,
  CalendarClock,
  Check,
  HardHat,
  AlarmClock,
  SkipForward,
} from "lucide-react";
import { Button, cn } from "@/ui";
import { BlockDialog, PostponeDialog, SkipDialog, SnoozeDialog, UnblockButton } from "./TaskActions";
import { BookDialog, type BookDialogProvider } from "./BookDialog";
import {
  CompleteDialog,
  type CompleteDialogMember,
  type CompleteDialogProvider,
} from "./CompleteDialog";
import type { MaterialLine } from "./materials";

export interface TaskActionBarProps {
  occurrenceId: string;
  title: string;
  dueDate: string;
  originalDueDate: string;
  today: string;
  limitDate: string;
  viewerId: string;
  members: readonly CompleteDialogMember[];
  providers: readonly (CompleteDialogProvider & BookDialogProvider)[];
  materials: readonly MaterialLine[];
  estimatedMinutes: number | null;
  assetName: string | null;
  isConditionTask: boolean;
  hasPlan: boolean;
  blocked: boolean;
  booked: boolean;
  canSnooze: boolean;
  defaultProviderId: string | null;
  /** Suggested by the plan: the primary action then leads with booking instead of completing. */
  requiresProfessional: boolean;
}

export function TaskActionBar({
  occurrenceId,
  title,
  dueDate,
  originalDueDate,
  today,
  limitDate,
  viewerId,
  members,
  providers,
  materials,
  estimatedMinutes,
  assetName,
  isConditionTask,
  hasPlan,
  blocked,
  booked,
  canSnooze,
  defaultProviderId,
  requiresProfessional,
}: TaskActionBarProps) {
  const [open, setOpen] = useState<
    "complete" | "postpone" | "snooze" | "skip" | "block" | "book" | null
  >(null);

  return (
    <>
      <div
        className={cn(
          "sticky bottom-0 z-10 -mx-4 mt-2 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur",
          "sm:-mx-6 sm:px-6",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="lg"
            className="flex-1 sm:flex-none"
            icon={<Check aria-hidden="true" />}
            onClick={() => setOpen("complete")}
          >
            Complete…
          </Button>
          {canSnooze ? (
            <Button
              variant="secondary"
              size="lg"
              icon={<AlarmClock aria-hidden="true" />}
              onClick={() => setOpen("snooze")}
            >
              Snooze
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="lg"
            icon={<CalendarClock aria-hidden="true" />}
            onClick={() => setOpen("postpone")}
          >
            Postpone
          </Button>
          {blocked ? (
            <UnblockButton occurrenceId={occurrenceId} />
          ) : (
            <Button
              variant="secondary"
              size="lg"
              icon={<Ban aria-hidden="true" />}
              onClick={() => setOpen("block")}
            >
              Waiting for…
            </Button>
          )}
          {booked ? null : (
            <Button
              variant={requiresProfessional ? "secondary" : "ghost"}
              size="lg"
              icon={<HardHat aria-hidden="true" />}
              onClick={() => setOpen("book")}
            >
              Book a professional
            </Button>
          )}
          <Button
            variant="ghost"
            size="lg"
            icon={<SkipForward aria-hidden="true" />}
            onClick={() => setOpen("skip")}
          >
            Skip
          </Button>
        </div>
      </div>

      {open === "complete" ? (
        <CompleteDialog
          open
          onOpenChange={(next) => setOpen(next ? "complete" : null)}
          occurrenceId={occurrenceId}
          title={title}
          dueDate={dueDate}
          today={today}
          viewerId={viewerId}
          members={members}
          providers={providers}
          materials={materials}
          estimatedMinutes={estimatedMinutes}
          assetName={assetName}
          isConditionTask={isConditionTask}
        />
      ) : null}

      {open === "postpone" ? (
        <PostponeDialog
          open
          onOpenChange={(next) => setOpen(next ? "postpone" : null)}
          occurrenceId={occurrenceId}
          dueDate={dueDate}
          originalDueDate={originalDueDate}
          today={today}
          limitDate={limitDate}
        />
      ) : null}

      {open === "snooze" ? (
        <SnoozeDialog
          open
          onOpenChange={(next) => setOpen(next ? "snooze" : null)}
          occurrenceId={occurrenceId}
          today={today}
        />
      ) : null}

      {open === "skip" ? (
        <SkipDialog
          open
          onOpenChange={(next) => setOpen(next ? "skip" : null)}
          occurrenceId={occurrenceId}
          dueDate={dueDate}
          hasPlan={hasPlan}
        />
      ) : null}

      {open === "block" ? (
        <BlockDialog
          open
          onOpenChange={(next) => setOpen(next ? "block" : null)}
          occurrenceId={occurrenceId}
        />
      ) : null}

      {open === "book" ? (
        <BookDialog
          open
          onOpenChange={(next) => setOpen(next ? "book" : null)}
          occurrenceId={occurrenceId}
          dueDate={dueDate}
          today={today}
          providers={providers}
          defaultProviderId={defaultProviderId}
        />
      ) : null}
    </>
  );
}
