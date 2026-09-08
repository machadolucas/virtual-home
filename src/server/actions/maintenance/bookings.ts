"use server";
/**
 * Professional bookings and the providers they are made with.
 *
 * The one thing this module must never do is imply the work is done. §3.2 and binding policy 3:
 * **a booking is not a completion.** Creating one leaves the due date alone, leaves the reminder
 * series alone, and records `service_booking_id` on the occurrence as a decorator — so the task
 * shows up under "Blocked / waiting" with the appointment beside it and still needs a real
 * completion afterwards. "Also postpone to the appointment date" is offered as a separate,
 * explicit choice.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import {
  BOOKING_STATUSES,
  maintenanceOccurrence,
  serviceBooking,
  serviceProvider,
} from "@/db/schema/maintenance";
import { ConflictError, NotFoundError } from "@/domain/errors";
import { loadOccurrence, postpone, writeAuditLog, writeOccurrenceEvent } from "@/domain/occurrence";
import { instantOf } from "@/domain/time";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { domainCall, id, idempotencyKey, localDate, optionalNote, revalidateMaintenance } from "./shared";

const timeOfDay = z.string().regex(/^\d{2}:\d{2}$/);

export const createProvider = action(
  z.object({
    name: z.string().trim().min(1).max(200),
    trade: z.string().trim().max(80).nullish(),
    contactName: z.string().trim().max(200).nullish(),
    phone: z.string().trim().max(80).nullish(),
    email: z.string().trim().max(200).nullish(),
    website: z.string().trim().max(500).nullish(),
    notes: optionalNote.nullish(),
    isPreferred: z.boolean().optional(),
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const providerId = domainCall("create_provider", () =>
      writeTx(handle.db, (tx) => {
        const rowId = newId();
        const now = ctx.clock.now();
        tx.insert(serviceProvider)
          .values({
            id: rowId,
            name: input.name,
            trade: input.trade ?? null,
            contactName: input.contactName ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            website: input.website ?? null,
            notes: input.notes ?? null,
            isPreferred: input.isPreferred ?? false,
            createdAtMs: now,
            updatedAtMs: now,
            createdBy: ctx.actorUserId,
            updatedBy: ctx.actorUserId,
          })
          .run();
        writeAuditLog(tx, ctx, {
          entityTable: "service_provider",
          entityId: rowId,
          action: "created",
          summary: `Added provider "${input.name}"`,
        });
        return rowId;
      }),
    );
    return { providerId };
  },
);

/**
 * Book a professional for an open task.
 *
 * `alsoPostponeToAppointment` is opt-in and does a real `postpone` — which re-anchors the reminder
 * series exactly as any other postpone would. Without it the due date is untouched, because the
 * appointment is when someone is coming, not when the work becomes not-overdue.
 */
export const bookProfessional = action(
  z.object({
    occurrenceId: id,
    providerId: id,
    /** Household-local date of the appointment. */
    scheduledDate: localDate.optional(),
    startTime: timeOfDay.optional(),
    endTime: timeOfDay.optional(),
    /** "between 8 and 12" — free text, because that is how providers actually answer. */
    windowNote: z.string().trim().max(200).nullish(),
    reference: z.string().trim().max(120).nullish(),
    contactNote: optionalNote.nullish(),
    status: z.enum(BOOKING_STATUSES).optional(),
    alsoPostponeToAppointment: z.boolean().optional(),
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx, settings } = maintenanceContext(session.user.id);

    const result = domainCall("book", () =>
      writeTx(handle.db, (tx) => {
        const occ = loadOccurrence(tx, input.occurrenceId);
        if (occ.status !== "pending" && occ.status !== "due") {
          throw new ConflictError("occurrence_not_open", `occurrence is ${occ.status}`, {
            status: occ.status,
          });
        }
        if (occ.serviceBookingId !== null) {
          throw new ConflictError("already_booked", "this task already has a booking", {
            bookingId: occ.serviceBookingId,
          });
        }
        const provider = tx
          .select({ id: serviceProvider.id, name: serviceProvider.name })
          .from(serviceProvider)
          .where(eq(serviceProvider.id, input.providerId))
          .get();
        if (!provider) throw new NotFoundError("service_provider", input.providerId);

        const now = ctx.clock.now();
        const bookingId = newId();
        const startMs =
          input.scheduledDate === undefined || input.startTime === undefined
            ? null
            : instantOf(input.scheduledDate, input.startTime, settings.timezone);
        const endMs =
          input.scheduledDate === undefined || input.endTime === undefined || startMs === null
            ? null
            : instantOf(input.scheduledDate, input.endTime, settings.timezone);

        tx.insert(serviceBooking)
          .values({
            id: bookingId,
            occurrenceId: occ.id,
            providerId: provider.id,
            status: input.status ?? "requested",
            requestedAtMs: now,
            scheduledStartMs: startMs,
            scheduledEndMs: endMs !== null && startMs !== null && endMs >= startMs ? endMs : null,
            scheduledLocalDate: input.scheduledDate ?? null,
            windowNote: input.windowNote ?? null,
            reference: input.reference ?? null,
            contactNote: input.contactNote ?? null,
            createdAtMs: now,
            updatedAtMs: now,
            createdBy: ctx.actorUserId,
            updatedBy: ctx.actorUserId,
          })
          .run();

        tx.update(maintenanceOccurrence)
          .set({ serviceBookingId: bookingId, updatedAtMs: now, updatedBy: ctx.actorUserId })
          .where(eq(maintenanceOccurrence.id, occ.id))
          .run();

        writeOccurrenceEvent(tx, ctx, {
          occurrenceId: occ.id,
          kind: "booked",
          detail: {
            bookingId,
            providerId: provider.id,
            providerName: provider.name,
            scheduledLocalDate: input.scheduledDate ?? null,
          },
        });
        writeAuditLog(tx, ctx, {
          entityTable: "maintenance_occurrence",
          entityId: occ.id,
          action: "booked",
          summary: `Booked ${provider.name}${input.scheduledDate ? ` for ${input.scheduledDate}` : ""} — booking is not a completion`,
        });

        let postponedTo: string | null = null;
        if (input.alsoPostponeToAppointment === true && input.scheduledDate !== undefined) {
          postpone(
            tx,
            ctx,
            occ.id,
            input.scheduledDate,
            `appointment with ${provider.name}`,
          );
          postponedTo = input.scheduledDate;
        }

        return { bookingId, planId: occ.planId, postponedTo };
      }),
    );

    revalidateMaintenance(input.occurrenceId, result.planId ?? undefined);
    return result;
  },
);

/**
 * Change a booking's status (confirmed, rescheduled, attended, cancelled…).
 *
 * `attended` is *still* not a completion: the occurrence stays open until someone records what was
 * done. Cancelling a booking clears the decorator so the task leaves the "waiting" group.
 */
export const updateBooking = action(
  z.object({
    bookingId: id,
    occurrenceId: id,
    status: z.enum(BOOKING_STATUSES),
    scheduledDate: localDate.nullish(),
    windowNote: z.string().trim().max(200).nullish(),
    reference: z.string().trim().max(120).nullish(),
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    domainCall("update_booking", () =>
      writeTx(handle.db, (tx) => {
        const booking = tx
          .select()
          .from(serviceBooking)
          .where(eq(serviceBooking.id, input.bookingId))
          .get();
        if (!booking) throw new NotFoundError("service_booking", input.bookingId);
        const now = ctx.clock.now();

        tx.update(serviceBooking)
          .set({
            status: input.status,
            scheduledLocalDate:
              input.scheduledDate === undefined ? booking.scheduledLocalDate : input.scheduledDate,
            windowNote: input.windowNote === undefined ? booking.windowNote : input.windowNote,
            reference: input.reference === undefined ? booking.reference : input.reference,
            updatedAtMs: now,
            updatedBy: ctx.actorUserId,
          })
          .where(eq(serviceBooking.id, booking.id))
          .run();

        if (input.status === "cancelled") {
          tx.update(maintenanceOccurrence)
            .set({ serviceBookingId: null, updatedAtMs: now, updatedBy: ctx.actorUserId })
            .where(eq(maintenanceOccurrence.id, input.occurrenceId))
            .run();
          writeOccurrenceEvent(tx, ctx, {
            occurrenceId: input.occurrenceId,
            kind: "booking_cancelled",
            detail: { bookingId: booking.id },
          });
        }

        writeAuditLog(tx, ctx, {
          entityTable: "service_booking",
          entityId: booking.id,
          action: "updated",
          summary: `Booking is now ${input.status}${input.status === "attended" ? " — the task still needs a recorded completion" : ""}`,
          changes: { status: [booking.status, input.status] },
        });
      }),
    );
    revalidateMaintenance(input.occurrenceId);
    return { bookingId: input.bookingId, status: input.status };
  },
);
