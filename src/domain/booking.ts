import { ConflictError, ValidationError } from "./errors";
import { instantOf, localTimeOf } from "./time";
/** Preserve wall-clock times when changing an appointment's date; clearing its date clears instants. */
export function bookingWindow(input: { date: string | null; startTime?: string | null; endTime?: string | null; previousStartMs?: number | null; previousEndMs?: number | null }, tz: string) {
  const start = input.startTime === undefined ? (input.previousStartMs == null ? null : localTimeOf(input.previousStartMs, tz)) : input.startTime;
  const end = input.endTime === undefined ? (input.previousEndMs == null ? null : localTimeOf(input.previousEndMs, tz)) : input.endTime;
  if (input.date === null) {
    if (input.startTime || input.endTime) throw new ValidationError("booking_date_required", "Choose a date before setting appointment times");
    return { scheduledStartMs: null, scheduledEndMs: null };
  }
  if (end && !start) throw new ValidationError("booking_start_required", "Set the start time before the end time");
  const startMs = start ? instantOf(input.date, start, tz) : null;
  const endMs = end ? instantOf(input.date, end, tz) : null;
  if (endMs !== null && startMs !== null && endMs < startMs) throw new ValidationError("booking_time_range", "End time must not be before start time");
  return { scheduledStartMs: startMs, scheduledEndMs: endMs };
}
export function assertBookingAssociation(bookingOccurrenceId: string | null, occurrenceId: string, currentBookingId: string | null, bookingId: string) {
  if (bookingOccurrenceId !== occurrenceId || currentBookingId !== bookingId) throw new ConflictError("booking_mismatch", "This appointment is no longer the task's current booking");
}
