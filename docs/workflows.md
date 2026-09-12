# Providers, record links, search and storage repair

These interfaces complete the connections between maintenance, household records and documents.
They use the existing session and `writeTx` boundaries; the public repository contains synthetic
fixtures only.

## One-time work

A **Once only** plan asks for a due date and immediately creates its single task. This date is a
schedule input, never a completion. Completing or skipping the task creates no successor; later
scheduler ticks cannot recreate it. An unknown date creates no task until setup is completed.

## Professional maintenance

`/providers` is the provider directory. Search by name, trade or contact, add a provider, and open
its details to edit contact information, preferred status and notes. Details link to its usual
maintenance plans, bookings, recorded completions and service documents. A name is required; other
fields can be filled later. Email and HTTP(S) website fields are validated.

The usual-provider field in a maintenance plan, and provider fields in booking dialogs, share an
inline **Add provider** action. Saving the provider selects it and preserves the maintenance draft.
**Manage providers** opens the directory in a separate tab so it does not discard the draft.

Archiving removes a provider from new choices and clears their usual-provider setting on plans.
Existing bookings, completions and documents retain their references. Restoring makes the provider
available again; it does not silently recreate old plan defaults. Provider records are never
hard-deleted through this interface. Shared service functions in `src/server/services/providers.ts`
validate, write and audit these changes for both the web interface and local integrations.

Bookings retain their distinction from work: recording a booking or marking attendance never
completes a task. A booking can change its provider, date, times, stated arrival window, reference,
contact note and status. Rescheduling preserves the household-local wall times across daylight
saving changes. Clearing the appointment date clears both time instants. Invalid time ranges are
rejected explicitly. A cancellation validates that the booking is still this task's current
booking before clearing it; it cannot clear another task's appointment.

## Links and finding records

`/search` provides paginated results across equipment, supplies, rooms, projects, procedures, plans,
tasks, recorded work, providers and documents. The header's keyboard-accessible **View all results**
opens that page. Matching and pagination are server-side; a capped group explicitly offers more
results. Search accepts literal text, so `%` and `_` are not database wildcards.

Project relationship fields use the authenticated `/api/project-link-candidates` endpoint and a
paginated picker for every supported record kind, including tasks, completions and service
records. Users do not need to copy database IDs. Tasks and completed history entries provide
**Add to project**, and a project's timeline links to the exact recorded completion.

`/history?completion=<id>` isolates a completion, including a voided entry belonging to a task
that has since reopened. This avoids navigating to a newer completion on the same task. The
ordinary history page uses expandable rows on phones and the detailed table on larger screens.

Equipment, supply and project metadata loaders authenticate before reading private record names.
A parent layout's session check is not relied upon to protect parallel metadata work.

## Reversible storage repair

Settings → System → Storage integrity reports missing original/derivative files, files without
attachment metadata, and project links whose target record is missing. Interactive inspection is
read-only: it does not acknowledge, raise or resolve background alerts. The worker's nightly scan
continues raising or resolving its deduplicated integrity alerts. A partial or failed storage scan
is reported as an error, never presented as a clean result. Symbolic-link storage roots are refused.

**Move to quarantine** requires a fresh session and rechecks references under the DB write lock.
Referenced originals and generated image copies cannot be quarantined. A file written within the
last minute is refused because the upload pipeline installs files before committing metadata.
Traversal, aliases, symbolic links and nonregular files are rejected.

Quarantine and restore stage a hard link without overwriting any existing path, retain the original
until the database journal commits, then remove the original link. A failed transaction removes
only the staged link. The source bytes remain recoverable if the process stops between stages; a committed journal
identifies any remaining cleanup. If final cleanup fails, both copies and the journal remain: **Restore file**
or **Clean up copy** retries the cleanup after verifying they still reference the same bytes.
A changed or occupied path is never overwritten or removed. Quarantine must be on the same
filesystem as attachments; a failed hard-link operation preserves the source and reports an error.

Restoration reloads the current quarantine row, validates its original path and current attachment
references, and refuses to substitute quarantined bytes for a newly registered attachment. No
attachment record or project relationship is deleted automatically. Audit records identify the
household member who quarantined or restored each file.
