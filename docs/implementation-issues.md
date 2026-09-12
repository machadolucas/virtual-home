# Interface audit and issue inventory

This inventory distinguishes actual workflow gaps from stale documentation and deliberate
operational restrictions. It records implementation status, not claims about untested devices or
production deployment. See `docs/workflows.md` for provider, search, relationship and repair rules.

## Confirmed gaps now addressed

| Finding | Implemented behavior | Validation |
|---|---|---|
| Supply details invoked default factories across the client/server boundary | Shared serializable lot/supplier defaults permit server rendering | Synthetic supply creation/detail browser regression |
| A snooze constant exported from a server-action module broke all task action dispatch | Module exports only callable server actions | AST export-boundary regression and booking browser journey |
| Once-only plans never generated their first task | Explicit due date creates exactly one task; terminal work never regenerates | Initial-date, no-history, repeated-tick, skip and completion domain regressions |
| Professional plans offered only existing providers; provider creation was buried in booking | Provider directory, detail/edit/archive, inline creation and preserved plan draft | Provider service/action tests; synthetic desktop/phone workflow tests |
| Booking changes trusted an independently supplied task ID and retained instants from an old date | Current association validation and household-local date/time rescheduling; editable provider/contact fields | Cross-task cancellation, daylight saving and invalid-window tests |
| Projects required raw IDs for tasks, completions and service documents | Paginated record pickers and reciprocal Add to project actions | Relationship/search tests; browser acceptance remains below |
| Project completion links went to generic history | Exact completion filter, including older voided work after reopening | Completion-filter regression test |
| History required a wide table on phones | Expandable phone entries retaining notes, materials, photos and links | Narrow Chromium and WebKit phone route/layout audit with recorded work |
| Header search capped results without continuation and omitted important record types | Dedicated paginated search page and View all results; provider/task/completion/document coverage | Search pagination, literal wildcard and provider lookup tests |
| Private metadata queries relied on parent layout authentication | Explicit session check before equipment/supply/project metadata reads | Unauthenticated and revoked signed-cookie HTML navigation regression for all three record families |
| Storage mismatch reports had no actionable reversible file workflow | Read-only integrity report plus fresh-session quarantine/restore with current-reference checks | Integrity repair and worker tests, including filesystem/transaction failures |
| File moves could overwrite destinations or outlive a rolled-back journal | No-overwrite hard-link staging, retained originals until commit, cleanup retry | Symlink, occupied-path, failed-commit, failed-unlink and only-copy preservation tests |
| Integrity alerts used a kind absent from the existing CHECK constraint | Leaf-table-only alert migration admits `integrity`; existing data and indexes preserved | Migration SQL inspection and worker integrity tests |

The coordinated interface update also implements viewer pan/fullscreen controls, visible global
alerts, a document library and local MCP access. Their detailed behavior and validation belong to
the architecture, security, house-view and document documentation maintained with those changes.

## Documentation that was stale, not missing implementation

- Model reconciliation was already implemented: imports create a pending reconciliation, users
  choose per-row decisions, and applying it changes the active model. The old UX paragraph saying
  there were no reconciliation buttons was obsolete. Preserve the working workflow.
- Booking change/cancellation controls already existed. The audit identified missing edit fields
  and association/time correctness problems; it did not require replacing booking lifecycle logic.
- Equipment documents and photos already supported authenticated upload/read/unlink. Service
  document metadata and general document discovery were separate missing workflows.
- Project timelines already derived only from explicitly linked completions. Improvements keep
  that rule; project dates never manufacture maintenance history.

## Intentional restrictions retained

- Creating users, resetting another user's password and other account provisioning require the
  local admin CLI. Home Assistant credentials remain in the server environment.
- Fixed-weekly recurrence was excluded from the first-version design. There was no visible broken
  control offering it; its absence is not evidence of a regression.
- No fuzzy automatic equipment identity matching: HA identities remain registry/device identities.
- A booking, attendance, telemetry recovery, snooze or schedule anchor is not a completion.
- Archival and reversible corrections preserve history. Public source never includes household
  models, manuals, photos, databases, credentials or real operational fixtures.

## Browser coverage

`tests/e2e/route-audit.spec.ts` exercises all 28 authenticated static pages and the root redirect,
then follows accessible links to equipment, supplies, projects, plans, procedures, providers,
documents and task details. It checks desktop, a 360-pixel touch phone, a 1024-pixel touch tablet,
and native WebKit at phone dimensions for horizontal document overflow, uncaught errors, server
errors, main/heading landmarks and useful shopping/notification/integrity empty states. Screenshots
are captured for each route. The same suite creates named records through the interface, books,
reschedules, cancels and completes work, links tasks/completions/service documents through search
pickers, and verifies exact completion history.

The metadata regression retains a real signed session token, signs out to revoke it, then checks
HTML navigation responses both without cookies and with the revoked token (omitting the signed
cookie-cache blob). Private equipment, supply and project names must be absent from those responses.

## Acceptance and operational checks still required

- Real trackpad gestures and actual Safari/iOS fullscreen fallback need hands-on validation on the
  household devices; synthetic Chromium phone tests do not establish that behavior.
- The synthetic project → task → completion → project link cycle passes, including service-record
  links and booking reschedule/cancel. Review dense history on household devices with actual
  representative content; synthetic fixtures cannot establish every real content shape.
- Combined verification results are recorded in `docs/verification.md`; production build and
  deployment health are checked separately during rollout.
- Review production migration/backup and deployment status separately; this issue inventory does
  not assert that the new version has been deployed or that external desktop MCP clients connected.
