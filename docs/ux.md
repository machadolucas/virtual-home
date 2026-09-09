# UX and the design system

What the app should feel like: **a calm architectural workspace**, not a dashboard. Crisp
typography on paper-coloured surfaces, restrained colour, one accent, real density on desktop and
real thumb targets on a phone. No decorative charts, no fake statistics, no animation that loops.

Tokens live in `src/app/globals.css`; components in `src/ui` (`src/ui/shell` for the app frame).
Where this document and the code disagree, the code wins — but change both.

---

## 1. Navigation

Flat top-level sections, shared by desktop and phone navigation:

| Section | Route | What it answers |
|---|---|---|
| Today | `/today` | What needs doing now, and what was just finished. |
| House | `/house` | The 3D house: rooms, surfaces, equipment, their history. |
| Equipment | `/equipment` | Equipment records, links and bulk removal. |
| Projects | `/projects` | Household projects. |
| Plans | `/plans` | Recurring work. |
| Procedures | `/procedures` | Instructions. |
| Shopping list | `/supplies/shopping` | What to buy. |
| Supplies | `/supplies` | What is in stock, what to buy. |
| History | `/history` | What was actually done, by whom, with proof. |

Plus **Settings** (`/settings`): it sits at the bottom of the sidebar
on desktop and inside the account menu on phones. Its sub-navigation is
`Security · Household · Users · Home Assistant · House model · System`, grouped as *Your account*,
*Household*, *System*.

`/` redirects to `/today`. There is no landing page: the app opens on the work.

The nav table is `src/ui/shell/nav.ts` — a single source for the sidebar, the phone tab bar, the
settings sub-navigation and the settings index. `isActive(href, pathname)` decides selection by
longest prefix, so `/house/room/kitchen` still highlights House.

## 2. Layout rules

The shell (`src/ui/shell/AppShell.tsx`) is a fixed-height frame:

```
h-dvh, overflow-hidden
├─ sidebar (desktop only)        w-sidebar / w-sidebar-collapsed
└─ column
   ├─ header                     h-topbar   search · HA pill · account
   ├─ main   min-h-0 flex-1 overflow-hidden      <-- DOES NOT SCROLL
   └─ tab bar (phones only)      h-tabbar   in normal flow, not fixed
```

**`<main>` never scrolls.** A page therefore chooses one of two contracts:

- **Ordinary page** — wrap content in `PageScroll`, which owns the scroll container, the max width
  (`max-w-6xl`) and the page padding. Every page except `/house` does this.
- **Workspace page** — fill the box and manage overflow yourself (`Workspace` is the helper).
  `/house` needs this: a full-viewport 3D canvas with no page scroll and no iOS rubber-banding.

Two consequences worth knowing:

- A page that forgets `PageScroll` simply cannot be scrolled. That is the intended failure mode —
  better than two nested scrollbars nobody can explain.
- The phone tab bar is in normal document flow, so `<main>` already excludes its height. Nothing
  needs bottom padding to compensate, and the workspace gets exactly the space that is left.

Inside a page: `PageHeader` (eyebrow, `<h1>`, description, actions) then `Panel`s. **Panels do not
nest.** A panel inside a panel means the information architecture is wrong, not that a border is
missing.

### House workspace controls

The desktop right panel has one scroll region for details, equipment placement or route editing.
Floor shortcuts float at the bottom-left of the canvas, grouped by building as vertical stacks that
match their physical floor order. Their icon-only buttons retain accessible names and hover labels.
Choosing a floor frames it in the regular perspective view, leaves orbit controls available, and
retains lower supporting floors in that building and every other building. The bottom View controls
panel contains View (Sims-style wall mode, cutaway, explode), Layers (visibility and route legend),
and Rendering (performance, background, daylight and shadows) tabs. Wall mode is
one of All cut, Contextual, All up, or All up + roof/ceiling; Show inside is the quick contextual
preset. Camera presets and Download image remain available when the bottom panel is collapsed.
Immediate visibility settings use switches. Controls use compact desktop spacing and retain larger
phone touch targets.

Starting an edit opens the right panel. Collapsing it discards the unsaved placement or route draft
without confirmation, restores the existing route when applicable, and returns focus to the canvas.
Placement cancellation restores the prior exploded view. Save/remove requests disable dismissal
until the request completes. Placement Save/Cancel actions remain pinned within the scroll region.

Download image saves a PNG of the visible model, background and labels at the current canvas
resolution. It excludes panels and editing guides, works on desktop and phone, and reports capture
errors beside the button.

## 3. Tokens

### Colour

Light is the design target; dark is a full re-tint, not an inversion. `:root` holds the light ramp
as `--vh-*` values; two blocks override the ramp for dark (`prefers-color-scheme: dark` unless
`[data-theme="light"]`, and `[data-theme="dark"]` for an explicit choice). `@theme inline` maps the
ramp onto Tailwind names, so **one class follows both modes** and there is no `dark:` variant
anywhere in the codebase.

| Group | Tailwind names | Use |
|---|---|---|
| Paper | `paper`, `surface`, `surface-2`, `surface-3`, `surface-4` | page → panel → input/stripe → hover → pressed |
| Lines | `line`, `line-strong` | hairlines; input and emphasis borders |
| Ink | `ink`, `ink-2`, `ink-3`, `on-accent` | primary, secondary, muted, text on accent |
| Accent | `accent`, `accent-hover`, `accent-active`, `accent-soft`, `accent-text` | one deep blue (`#2f5fd0`) for selection and primary actions |
| Status | `ok`, `due`, `overdue`, `blocked`, `unknown`, `stale` (+ `*-soft`) | see §5 |
| Viewport | `viewport` | the ground behind the 3D house — `#f4f4f2` light, `#100f0e` dark |
| Effects | `ring`, `scrim` | focus ring, overlay backdrop |

**There is one control for the mode**: System / Light / Dark in the account menu
(`src/ui/shell/ThemeMenu.tsx`), stored as `vh-theme` in `localStorage` and applied by a blocking
inline script in `<head>` (`themeScript()` in `src/ui/shell/theme.ts`) before the first paint —
which is why a pinned dark theme never flashes white on navigation. `system` **removes**
`data-theme` rather than setting a third value, because that is exactly what the token blocks are
written against. The choice is per browser and grants nothing, so it never reaches the database;
the one appearance setting that *is* shared is the 3D background (§11.4).

Every ink and status foreground clears 4.5:1 on its intended background in both modes. Avatar
display colours are used at ~20 % over the panel surface with ink-coloured text, so an arbitrary
stored hue can never make initials unreadable — and a non-hex value is rejected before it reaches
CSS.

### Space, radius, shadow

Spacing is Tailwind's 4 px scale. Named layout metrics: `--vh-sidebar-w` (15rem),
`--vh-sidebar-w-collapsed` (3.5rem), `--vh-topbar-h` (3.25rem), `--vh-tabbar-h` (3.75rem) — exposed
as `w-sidebar`, `h-topbar`, `h-tabbar`.

Radius: `rounded-xs` 3px (dots, key caps) · `sm` 5px (inputs, badges) · `md` 8px (buttons, rows) ·
`lg` 12px (panels) · `xl` 16px (dialogs, sheets).

Shadow: `shadow-panel` (a panel sitting on paper) · `shadow-pop` (popovers, toasts) ·
`shadow-overlay` (dialogs, sheets). Nothing else casts a shadow.

### Typography

Inter Variable, vendored under `src/app/fonts/` (SIL OFL 1.1, `Inter-LICENSE.txt`, unmodified) and
loaded with `next/font/local` — not a CDN, because the CSP is `font-src 'self' data:` and the app
must work with no internet. Monospace is a system stack (`--font-mono`), used only for ids, keys and
`Kbd`.

Numbers use **tabular numerals**: `th`, `td`, `time`, `output` and the `.vh-tnum` class. Any figure
that can change between renders (quantities, due dates, counters) must be tabular so it does not
jitter.

### Motion

`--vh-dur-instant` 80ms · `--vh-dur-fast` 120ms · `--vh-dur-base` 180ms · `--vh-dur-slow` 260ms,
with `--vh-ease` and `--vh-ease-out`. Enter/exit animations are named keyframes (`vh-fade-in`,
`vh-pop-in`, `vh-slide-up`, `vh-slide-from-right`, …) applied through Radix `data-state`.

**No continuous animation exists in this app** — no shimmer skeletons, no marching progress stripes,
no pulsing status dots. The single exception is the busy spinner, and a global
`prefers-reduced-motion` block in `globals.css` clamps every duration to 1 ms and every iteration
count to 1, which leaves the spinner a static glyph. That block is the guarantee: it also covers
animations that come from Radix rather than from our classes.

## 4. Component inventory (`src/ui`)

| Component | Notes |
|---|---|
| `Button` | `primary` / `secondary` / `ghost` / `danger`; `sm` `md` `lg`; `loading` (spinner + `aria-busy` + disabled); `icon`, `iconTrailing`. `buttonClasses()` styles an `<a>`/`Link` identically. |
| `IconButton` | Icon-only; `label` is **required** and becomes the accessible name and title. 44 px below `md:`, 28–36 px above. |
| `Input`, `Textarea` | Shared `fieldSurface` chrome; `icon` / `trailing` slots; `aria-invalid` restyles the field. |
| `Field` | Label + control + help + error with real ids, via a **render callback** (`{ id, describedBy, invalid, errorId }`) — no `cloneElement` magic. Help text is never replaced by the error; both are announced. |
| `Select` | Searchable combobox for all lists, including viewer fields; typing filters labels and hints, arrows and Enter choose, Escape cancels. Options retain optional `hint` lines. |
| `Checkbox`, `Switch`, `RadioGroup` | 18 px controls inside ≥44 px rows on phones. `Switch` means "applies immediately"; `Checkbox` belongs in submitted forms. |
| `SegmentedControl` | Radix ToggleGroup, single mode; one tab stop, arrow keys between segments. Ignores deselection — a segmented control always has a selection. |
| `Dialog` | Centred modal for short decisions. Focus trap/restore, Escape, scroll lock from Radix. More than a couple of fields belongs on a page. |
| `Sheet` | Same Radix Dialog, anchored to an edge. `bottom` (phone default, ≤88 dvh, safe-area padded, grab handle) or `right` (desktop inspector). |
| `Popover` | Non-modal transient surface: filters, small menus, the account menu. |
| `Tooltip` | Supplementary only — tooltips do not exist on touch, so nothing essential lives here. `TooltipProvider` is mounted once by the shell. |
| `Tabs` | Underline + weight change marks the active tab. `TabsPanel` is the content. |
| `Badge`, `StatusBadge`, `StatusDot` | See §5. |
| `ConnectionPill` | `connected` / `degraded` / `disconnected` / `unknown` for Home Assistant. |
| `Panel` | The app's one container: bordered paper, optional header/footer, `flush` for tables, `fill` for workspace columns. |
| `EmptyState` | Icon, title, description, `bullets` (what *will* be here), actions, provenance `note`. The default look of an unfinished screen. |
| `Skeleton` | Static, unanimated placeholder. |
| `Kbd` | One key cap; compose for chords. |
| `Toast` | Module-scope store + `ToastViewport` (mounted in the root layout), no dependency. Outcomes of user actions only — never background events, because a toast nobody sees is a lost message. Errors persist until dismissed; other tones auto-dismiss. |
| `DataTable` | Dense, quiet, deliberately dumb: sorting/filtering/paging belong to the URL, not to component state. Sortable headers are real `<button>`s with `aria-sort` on the `<th>`. |
| `Breadcrumb` | House trails; the last crumb is `aria-current="page"` and never a link. |
| `Avatar` | Initials over a tint of the person's display colour; deterministic fallback colour from the name. |
| `ProgressBar` | Determinate, or a **static** striped track when indeterminate. |
| `Spinner` | The only looping animation; stops looping under reduced motion. |

Shell (`src/ui/shell`): `AppShell`, `SidebarNav`, `MobileTabBar`, `GlobalSearch`, `UserMenu`,
`HouseMark`, `PageScroll`, `PageHeader`, `Workspace`, `nav.ts`, `sidebarStore.ts`.

Helpers: `cn()`, `focusRing`, `focusRingInset`, and `status.ts` (pure, React-free, so the worker and
tests can use it).

`cn()` has no `tailwind-merge`, and that has one consequence worth knowing: **conflicting utilities
are resolved by stylesheet order, not by class-list order.** Appending the caller's `className` last
does not make it win — `p-1.5` after `p-3` still loses. So primitives do not set utilities callers
commonly override; they expose a prop instead (`Popover`'s `padded`, `Button`'s `size`, `Panel`'s
`flush`) or let `className` replace the default outright (`HouseMark`). Margins, `hidden` and grid
placement are safe to pass, because nothing sets them.

## 5. States

Six status kinds, each with its **own glyph** as well as its own colour:

| Kind | Glyph | Means |
|---|---|---|
| `ok` | check | Nothing due; last completion is inside the interval. |
| `due` | clock | Due now or within the household lead time. |
| `overdue` | warning triangle | Due date passed, no completion recorded. |
| `blocked` | ban | A supply is missing, or a professional is booked. |
| `unknown` | question | No data. **Never a value** — not zero, not "fine". |
| `stale` | cloud-off | The last reading is too old to trust. |

`unknown` and `stale` are different on purpose: "we have no reading" is not "we have an old
reading", and neither is "everything is fine". `STATUS_URGENCY` sorts `overdue → due → blocked →
stale → unknown → ok`; `unknown` ranks **above** `ok` because missing information is something to
look at.

Rules:

- **No colour-only meaning.** Status carries a glyph; selection carries a left rule *and* a tint;
  the active tab carries an underline *and* a weight change; a required field says "(required)".
- `Badge` wherever there is room for words. `StatusDot` only in dense rows, and it still carries an
  accessible name (pass `label={null}` only when the same status is spelled out in adjacent text).
- **Empty ≠ zero.** An empty screen gets an `EmptyState` that says what will appear and where it
  comes from. Never a "0" tile, never a placeholder chart, never an invented statistic.
- Loading is a `Skeleton` or a disabled control with a spinner — never a layout that jumps.
- Errors are specific about what failed and what was *not* changed. Sign-in is the one place with a
  deliberately generic message ("Wrong username or password"), with rate limiting as the single
  exception ("Too many attempts, wait a minute") because lockout and a typo need different
  reactions.

## 6. Keyboard conventions

| Key | Effect |
|---|---|
| `Tab` / `Shift-Tab` | Move between controls. Every interactive element is reachable. |
| `/` | Focus the global search — suppressed while typing in a field or contenteditable. |
| `Escape` | Close the top dialog, sheet, popover, select or tooltip; clear the search field. |
| `Enter` / `Space` | Activate the focused control. Password fields carry `enterKeyHint="go"`. |
| `↑` `↓` | Move within a Select/menu list. |
| `←` `→` | Move between tabs and segmented-control segments (one tab stop per group). |
| `Home` / `End` | First/last item in a Radix list. |

Also:

- **Skip to content** is the first focusable element on every app page (`#main`).
- Focus is always visible: a 2 px `ring`-coloured outline, offset 2 px (inset where an offset ring
  would be clipped). No component ever sets `outline: none` without a replacement.
- Focus order follows the DOM; nothing uses a positive `tabindex`.
- Dialogs and sheets trap focus and restore it to the trigger on close (Radix).
- The sidebar is a plain list of links — one tab stop each, `aria-current="page"` on the active row.
  No roving-focus widget to relearn.

## 7. Phones (below `md:`, 768 px)

Phones are for doing the work in front of you: instructions, completing a task, taking a photo,
checking a supply, finding a piece of equipment. Desktop is for planning and for the house model.

- Sidebar is replaced by a **bottom tab bar** with the same four sections in the same order; the
  active tab gets a tinted roundel plus a heavier stroke. Settings moves into the account menu.
- Every touch target is ≥44 px. `IconButton` grows to 44 px below `md:`; checkbox, switch and radio
  rows are ≥44 px tall even though the control itself is 18 px.
- Detail surfaces are bottom `Sheet`s (grab handle, ≤88 dvh, `env(safe-area-inset-bottom)` padding),
  not centred dialogs.
- `viewport-fit=cover` plus safe-area padding on the top bar, the tab bar and bottom sheets, so the
  notch and home indicator never overlap content.
- Toasts sit above the tab bar, centred, within thumb reach.
- Tables hide `desktopOnly` columns rather than shrinking to unreadable; wide content scrolls inside
  its own container so the page never scrolls sideways.
- The account menu, search hint key caps and tooltips degrade gracefully: nothing important is
  reachable only by hover.

## 8. Login (`/login`)

Centred card on a masked drafting grid — architectural, not cute. Behind
`VH_SHOW_ACCOUNT_HINTS`, the household members are pre-listed as avatar buttons: clicking one fills
the username and focuses the password field. That is deliberate user enumeration, and it is the
right trade for two accounts on a private hostname (see
`docs/design-notes/auth-security-operations.md` §3.7).

- The `username` input is **always in the DOM** — visually hidden when hints are shown, never
  removed and never `display: none` — so iOS Passwords and other managers can fill it and offer to
  save the pair. "Sign in as someone else" reveals it.
- "Keep me signed in" defaults to **on** (30 days of inactivity), wired to `rememberMe`.
- `next` is validated by `safeNextPath` (same-origin relative paths only), so a crafted Home
  Assistant notification link cannot bounce the user off-site after sign-in.
- On success the page does a **full navigation**, not a client push, so the proxy and every server
  component see the new cookie on the first request.
- Recovery is CLI-only (`pnpm vh-admin set-password`), stated in small text on the page. There is no
  mail transport, so there is no reset link to send — and none to steal.

## 9. Settings → Security

Reads a **fresh** session (bypassing the 60 s cookie cache) because it shows and revokes sessions.

Better Auth puts `/list-sessions` behind its fresh-session middleware (`freshAge` is 10 minutes), so
an ordinary long-lived session gets `403 SESSION_NOT_FRESH` instead of a list. That is a normal
state for this page, not an error: it renders an explanation and still offers "sign out all other
devices", which does not require freshness. Password change and single-session revoke work from any
valid session.

## 10. Maintenance screens

The maintenance slice is five routes plus one export handler. Server components by default, server
actions for every write, client components only where a decision needs a form.

| Route | What it is |
|---|---|
| `/today` | The daily list. Sections, an honest health banner, two quick actions per row. |
| `/tasks/[id]` | One task. The primary phone screen. |
| `/plans`, `/plans/new`, `/plans/[id]` | The recurring obligations and the form that defines them. |
| `/procedures`, `/procedures/[id]` | Written instructions, versioned and frozen on publish. |
| `/history` | What was actually done — and what was not. |
| `GET /api/exports/maintenance` | JSON (all datasets) or CSV (one dataset), with the §8.4 envelope. |

Code: pages under `src/app/(app)/{today,tasks,plans,procedures,history}`, reads in
`src/server/queries/maintenance/*`, writes in `src/server/actions/maintenance/*`, client components
and the pure helpers in `src/features/maintenance/*`. The helpers are React-free and tested
(`tests/unit/features/maintenance/`): `grouping.ts` (which section a row belongs to), `dueDate.ts`
(every date and due phrase in the slice), `materials.ts` (pre-fill and the short-line diff),
`schedule.ts` (form ↔ `RecurrenceRule`, and the preview), `progress.ts` (resume position).

### 10.1 The rule the whole slice is shaped by

CLAUDE.md rule 6 — **never fabricate maintenance history** — is a UI problem as much as a schema
one, because every convenient shortcut is a way to write a lie. So, concretely:

- **Nothing completes in one tap.** "Complete…" opens a dialog that asks when, who, and what was
  used. There is no "done" button on a list row.
- **A schedule anchor is not a completion.** Plan setup and the plan page say so in words; History
  shows no row for it, and the task header spells out where the next date came from
  (`anchorWording`).
- **A snooze is only a reminder.** The dialog says what it does not touch, and it is per person.
- **A postpone keeps `original_due_date`**, and the row shows both dates.
- **A skip requires a reason** and is labelled "skipped" everywhere, never "completed".
- **A booking is not a completion**, and neither is a provider attending. Both stay under
  "Blocked / waiting" with the task still open; moving the due date to the appointment is a
  separate checkbox.
- **A recovered condition reading closes nothing.** §6.5's three choices are the only way out.
- **A void is a visible correction**, not a deletion: History keeps the row, struck through, with
  the reason.
- **An approximate anchor never gets an exact overdue count** — the wording becomes "estimated
  overdue" rather than "overdue by 47 days".

### 10.2 `/today`

Five sections from `groupToday`, in this order: **Needs attention** (overdue or due today, split
into yours / shared / the other member's), **Ready to do** (inside 7 days), **Condition alerts**
(HA-derived, with the reading and the threshold), **Blocked / waiting**, **Upcoming 30 days**. A
sixth panel lists plans still waiting for a starting point.

Blocking beats the due date: a task you cannot start is in "waiting", not in "needs attention".
Condition work gets its own section at any due date, because the row needs the battery reading
beside it. Sort is `(priority DESC, due_date ASC)`, exactly as §3.3 specifies.

Row actions are **Open**, **Snooze 1 day** and **Postpone…** — the two that need no decision, plus
the one that needs a small one. Snooze is hidden when the viewer is not a recipient.

The health banner reads `integration_status` **and** `worker_heartbeat`, and keeps them apart: a
stale heartbeat means the *worker* is down, which is a different sentence from "Home Assistant is
unreachable". With no status row at all it says so — `unknown` is never rendered as healthy. When
everything is fine it collapses to one quiet line.

No page in this slice shows a computed statistic. Counts are counts of rows on the screen.

### 10.3 `/tasks/[id]`

The phone screen. Header (status, due, original due when postponed, assignee avatars, priority,
effort), the target with **Locate in house** (`/house?sel=equipment:<placementId>`, falling back to
`asset:<id>` / `room:<modelNodeId>`; a system says it has no single place), the condition panel
where relevant, the frozen instructions, materials with live stock, photos, the completion record,
the typed timeline, and earlier work on the same plan or unit.

- **Instructions come from the occurrence's frozen `procedure_version_id`**, never from the
  procedure's current version. Progress is stored per step and per checklist item, and the runner
  opens at the first step that is neither done nor skipped.
- **Materials** show the ledger balance — the same number the completion transaction checks — with
  a one-click "waiting for materials" that writes a block whose reason names the parts.
- **Photos** post to `/api/upload` (which sniffs the type and strips GPS) and are then linked by a
  server action; the input is `capture="environment"`, so a phone opens the camera.
- **Actions** live in a sticky bottom bar: Complete…, Snooze, Postpone, Waiting for…, Book a
  professional, Skip. Big targets, thumb reach, and `Complete…` first.
- **Insufficient stock** (§5.3) is handled inside the completion dialog: the response comes back
  with its lines, every field the user typed stays, each short line gets *Adjust stock up /
  Consume what's there / Note the discrepancy*, and resubmitting reuses the same `requestId` so a
  lost response cannot double-complete.

### 10.4 `/plans`

One page, not a wizard: every answer changes the schedule preview, and a wizard would hide it
behind "next". The schedule chooser offers six questions in plain language and says, for each, what
it does about drift — the difference between "6 months after it was last done" (drifts on purpose)
and "every April and October" (never moves) is the single hardest idea in the app. Under it, a live
preview of the next three dates, computed on the *server* by the same `computeNextDue` the
scheduler uses, in the household time zone, with its assumption stated.

The setup section ("When was this last done?") offers exact / approximate / pick a date / start now
/ the install date / ask me later. All six write an anchor. "Ask me later" saves the plan paused
and generates nothing.

Editing a plan never rewrites open work: an occurrence is a snapshot, so changes take effect on the
next one, and the page says that out loud.

### 10.5 `/procedures`

One editable draft per procedure. Publishing freezes the version and supersedes the previous one
without deleting it; editing a published version forks a new draft by copying it. `?version=<id>`
shows an older version read-only, which is how you check what a task from two years ago said. A
version with no steps cannot be published — a task with empty instructions is worse than none.

### 10.6 `/history`

One table, with the row type labelled: completions, voided completions, skipped, cancelled,
bookings. Filters (date range, target, types) live in the URL, so a filtered view is shareable and
survives a reload.

Exports are the whole record rather than the filtered view, because an export that silently omitted
rows is a worse file to keep. `?format=json` returns the envelope plus every dataset;
`?format=csv&dataset=…` returns one flat table and carries the envelope in `X-VH-Export-Context`
(one dataset per request rather than a zip, which would mean an archiver dependency to serve two
people on a LAN).

---

## 10. Supplies, equipment and settings screens

The three screens in this slice share one habit: **every number says where it came from, and
anything unknown says so in words.** That is the same rule as §5's status kinds, applied to
quantities, battery levels and health figures.

### 10.1 Routes

| Route | What it answers |
|---|---|
| `/supplies` | What is on the shelf, and what to buy. Filter chips (`To buy · Expiring · Kits · Everything`) and the search live in the URL, so a filtered list is a link. |
| `/supplies/new`, `/supplies/[partId]` | Define an item; see its ledger. `?edit=1` on the detail page swaps the panels for the form. |
| `/supplies/shopping` | Reorder suggestions grouped by supplier, plus copy-as-text. No purchasing, ever. |
| `/equipment` | Every unit, grouped by location, with battery, HA link state and open-task count. |
| `/equipment/new`, `/equipment/[assetId]` | Add a unit; see one unit's whole record. `?edit=1` as above. |
| `/equipment/systems` | The groupings that span rooms: ventilation, water, electrical, network. |
| `/settings/{household,users,home-assistant,model,system}` | Configuration, with the consequence of each field spelled out. |
| `/api/exports/{inventory,equipment}` | JSON, or `?format=csv&dataset=<name>`. Both carry the §8.4 envelope. |

`/equipment` and `/projects` have their own top-level navigation links. The phone bar scrolls horizontally to retain touch-sized targets. The equipment list supports filtered multi-selection and removal with confirmation; removal preserves history and retires HA links, allowing reimport. Its header links directly to HA import.

### 10.2 Quantities

Everything is integer thousandths in the database and unit-aware on screen
(`src/features/inventory/units.ts`):

- A whole amount never grows a decimal tail: `2000` is `2 pcs`, never `2.000 pcs`.
- A kit counts in **kits**, because that is what is on the shelf — `1 kit`, `2 kits` — even though
  its stored unit is `pcs`.
- A comma is accepted on input, because a Finnish keyboard produces one; the decimal separator on
  output is always `.`, because those strings end up in CSV and in copy-as-text.
- A **negative** balance renders as negative, with an `overdue` glyph and a "reconcile" call to
  action. It is how a noticed discrepancy is recorded honestly (§1.8), and clamping it to zero
  would hide exactly the row somebody needs to see.

### 10.3 The kit rule, said out loud

Every kit surface carries one sentence verbatim, from `src/features/inventory/labels.ts`:

> Stock is counted where the goods physically are; opening a kit moves its contents to the
> component parts.

It appears on the list when the `Kits` filter is on, on the part detail page, in the "Open a kit"
dialog, and next to the "this is a kit" checkbox — which is the moment somebody forms a mental
model of how counting works. `is_kit` is not editable afterwards: the ledger rows already written
mean different things on each side of that line.

### 10.4 Battery, and the words for "we do not know"

`src/features/assets/battery.ts` is the only place a battery reading becomes text, and it has no
code path that produces `0 %` from a missing reading (CLAUDE.md rule 8):

| Reading | Shown as | Status kind |
|---|---|---|
| A recent number | `72 %` | `ok`, or `due` at or under the household threshold |
| A number older than the stale window | `Last read 40 %` | `stale` |
| `unknown` / `unavailable` / non-numeric / no link | `Battery unknown` | `unknown` |
| A real `0` from HA | `0 %` | `due` |

`stale` and `unknown` stay distinct on screen, because "we have an old reading" and "we have no
reading" call for different actions.

### 10.5 HA link states are not all failures

`renamed` gets a **neutral** badge and a sentence saying nothing broke: every link stores the
entity registry id, so a rename in Home Assistant only makes the label we cached stale. `missing`
is the one that gets an `overdue` badge, and the only state a relink can repair. Relinking is
always a button and never automatic — repointing a link asserts that two registry entries are the
same physical device, and only the household can say that (§7.2).

### 10.6 Writes that never overwrite

- **Stock take** asks for the count and records the **delta**. When the shelf matches, nothing is
  written to the ledger and the screen says so — the count still lands in the audit trail, because
  "somebody counted and it agreed" is what makes the number trustworthy.
- **Correct** appends a mirror row pointing at the original; both stay visible, and the button
  disappears once a row has been corrected (the database allows exactly one).
- **Open a kit / undo** is one reversible movement group, not an availability derivation.
- **Replace equipment** creates a second `asset` row. Plans move forward; completions never do. The
  history panel shows the whole chain and marks the rows that belong to an earlier unit.
- **Retire** is deliberately separate from replacing: nothing took its place, so nothing claims to.
- **Acknowledge an alert** means "I have seen this", not "this is fixed" — `resolved_at_ms` stays
  null and only the condition going away clears it.

### 10.7 Settings, and what is deliberately absent

Settings → Household spells out the notification policy in prose and states that **09:00 is a
provisional default**. Every field says what changing it does, because "catch-up digest threshold"
means nothing on its own.

Three things are missing on purpose, and each page says why:

- **No user creation, no password reset for somebody else, no delete.** Those need machine access
  (`pnpm vh-admin`). The display colour is the one profile field a browser may change, because it
  is the one that grants nothing.
- **No Home Assistant token field.** It lives in the server environment and is scrubbed out of the
  error strings this page renders.
- **No reconciliation buttons.** `src/house/model/reconcile.ts` reports what a new package no
  longer knows; nothing yet writes `model_reconciliation` rows or applies a decision, so the panel
  lists whatever items exist and carries a TODO note rather than offering controls that do nothing.

Settings → System draws memory as a plain inline `<svg>` polyline baselined at **zero**, and refuses
to draw a trend from fewer than two samples: one point is not a trend, and a flat line would imply
a stability nobody observed. A missing `backup_run` row renders as "no backup has ever been
recorded" — that is the alert, not a gap in the page.

### 10.8 Exports

Both routes are behind `authed` and `private, no-store`. JSON returns every dataset by default;
`?dataset=<name>` narrows it. CSV serves **one dataset per file** with the §8.4 context as a leading
key/value block — one HTTP response is one file, so the context leads the CSV instead of sitting
beside it as `_context.json`. Conventions: a UTF-8 BOM and CRLF for Excel, ISO-8601 UTC instants
with a `*_local_date` companion, a decimal quantity beside every `*_milli`, empty fields for NULL,
and a leading `'` on anything Excel would treat as a formula.

---

## 11. The 3D workspace (`/house`)

The workspace is three landmark regions — tree · canvas · inspector — around one store and one
imperative scene. It is the only part of the app that draws pixels we do not own, and it once had
its own colour vocabulary. It does not any more.

### 11.1 The viewer uses the tokens, like everything else

`src/house/**` carries **no** hardcoded palette utility. Not `bg-white`, not `border-neutral-300`,
not `text-neutral-500`, not `bg-sky-50`. The whole tree is walked by
`tests/unit/house/tokens.test.ts`, which fails with the offending file and line, and whose
allow-list is empty. The mapping, when you are converting something:

| Was | Is | Why |
|---|---|---|
| `bg-white` on a panel | `bg-surface` | the tree panel, the inspector, the control bar |
| the workspace gutter, the canvas skeleton | `bg-paper`, `bg-surface-2` | page ground vs. a sunken fill |
| `bg-neutral-50/100` fills, table stripes, key caps | `bg-surface-2` | |
| `hover:bg-neutral-100/200` | `hover:bg-surface-3` (pressed: `surface-4`) | |
| `border-neutral-200/300` | `border-line`; inputs and emphasis `border-line-strong` | |
| `text-neutral-800/900` | `text-ink` | |
| `text-neutral-600/700` | `text-ink-2` | |
| `text-neutral-400/500` | `text-ink-3` | labels, metadata, legends, hints — never below 4.5:1 |
| `sky-*` | the `accent` family, and `outline-ring` for focus | selection and primary action |
| `amber-*` | `due` / `due-soft` | warnings, "inferred", uncertainty |
| `red-*` | `overdue` / `overdue-soft` | |
| grey informational badges | `unknown` / `unknown-soft`; stale telemetry `stale` / `stale-soft` | |

Reuse a primitive wherever it is a drop-in. The tree's search field is `Input` — which is the fix
for the reported bug, because `fieldSurface` is what carries the readable ink, the token surface and
a `placeholder:text-ink-3` that survives dark mode. Remember `cn()`'s caveat (§4): conflicting
utilities are resolved by stylesheet order, not class-list order.

The 2D plan and wall-elevation route editors are chrome too, so their SVG paint references the ramp
directly (`fill="var(--vh-paper-2)"`, `stroke="var(--vh-accent)"`) — a `fill` that flips with
selection cannot be a Tailwind utility.

### 11.2 Chips over the canvas

Anything floating over the render sits on a background that is a **household choice** — a token, a
solid colour, or a gradient. So it brings its own surface:

```
bg-surface/85 text-ink border border-line backdrop-blur-sm shadow-pop
```

(or the same with `surface-2`). Never a raw `bg-white/90` or `bg-neutral-900/85`: one of the two
disappears against a user gradient. This covers the room and equipment labels, the "+N" cluster
badge, the DOM marker buttons, the snap read-out and the loading bar.

### 11.3 Scene-side colours

three holds colours as numbers inside long-lived materials and instance attributes, so the scene
cannot follow a CSS variable on its own. `src/house/scene/palette.ts` resolves the values it needs
from the live `--vh-*` properties (with the shipped literals as the SSR/test fallback) and
`src/house/hooks/usePaletteSync.ts` re-pushes them on a theme change — one change, one re-apply, one
`invalidate()`.

In the palette: the selection emissive and its outline, the marker `instanceColor` per HA state, the
snap indicator, the route point handle, and the hue-neutral "planned" route. **Not** in the palette,
deliberately: `surface.defaultColor` and the architectural edges (that is the house, not the chrome,
and `NoToneMapping` exists so a saved hex renders literally), and `SYSTEM_COLORS` — the seven route
hues are colour-blind-safe identity, drawn against the model rather than the background, and the
ramp has no per-system hue to map them onto.

### 11.4 The background control

Modes are `theme` (the `--vh-viewport` token, and the default), `solid` and `gradient`
(`src/house/model/background.ts` — pure, so the viewer, the settings page and the server action can
all import it). Rendering is CSS on the canvas host; the WebGL context is transparent (D-024).

The control (`src/features/settings/HouseBackgroundControl.tsx`) is one component in two places: the
workspace's **Rendering** section, and Settings → Household → **Appearance**. Mode segmented
control, labelled colour inputs, a preset row, Reset. It is optimistic with revert-on-error, and the
write is debounced 600 ms — the same debounce the surface-colour picker uses, because a native
colour input fires on every pointer move.

It is **household-level**, and the copy says so: the model is the household's, and a per-person
background would have the two of them describing different pictures over the phone. NULL in the
column means "follow the theme", which is also what a malformed stored value falls back to — the
House page must not break on a hand-edited row.


### HA entity selection and bulk import

Entities belonging to equipment's active HA device links appear first in the entity picker, before
its result limit is applied. Disabled and hidden entries are filtered before limiting; enabled diagnostic and config
entities, including battery sensors, remain available. Associated entries are marked “This equipment’s device”.

Primary identifies the main function: occupancy for a motion sensor, or the light entity for a
lamp. Adding a primary entity moves a whole-device primary association to Status / reading;
it never silently replaces another primary entity. Status / reading also holds additional
measurements such as temperature, humidity and illuminance. These are measurement types already
provided by HA, not separate link roles. Power and battery level retain their specialized roles.
Selected rows in the HA bulk importer expose entity role controls before import.


### Equipment trash and focus

The equipment page has an **Active equipment / Trash** switch. Trash offers permanent multiselect
deletion for unused out-of-service records. Rows with service history, tasks, replacement chains,
projects, infrastructure, documents or other dependencies are locked with a reason. The server
rechecks eligibility inside the same transaction as deletion and records an audit entry; the
confirmation lists the records and explains that their owned HA links and placement setup also
get deleted. The toolbar stacks on narrower screens so selection counts cannot overlap actions.

The property tree omits the redundant address root, opens buildings and floors to show rooms by
default, and folds a single-floor building such as the garage into one row. Property-tree focus
consistently frames buildings and outdoor areas as well as floors, rooms and equipment. Floors and
rooms open in perspective from directly above with roofs, floor ceilings and upper floors out of
the way. Angled
equipment focus cuts camera-side and intervening wall assemblies low, preserving back walls and
mount surfaces for context. The reveal is temporary, resets with Overview and pauses during
editing. Choosing a floor clears an older room/equipment reveal so the requested floor always wins;
orbit remains available immediately afterward. The layer controls keep their saved settings.
Select and place reserve left-drag for their tool while wheel zoom and right-drag pan remain usable;
holding Space temporarily returns left-drag to the camera.

Room and floor names shown in the viewer prefer an explicit household label, then a confirmed Home
Assistant area or floor name, then the app location/model name. When confirmed room mappings on one
floor all point to the same HA floor, that HA floor name is used for display without creating a new
mapping. The room/floor inspector can rename labels and hide one room or all area labels on a floor;
resetting follows the automatic name again. Semantic `attic` and `void` rooms start hidden, without
private-name rules. **Area labels** in Layers hides building and room labels together while leaving
equipment labels visible; phones expose the same switch beside the model.

### Live fixtures

Equipment labels show their main linked reading. Clicking a label expands its other linked readings;
battery-linked equipment includes its percentage. The placement's chosen silhouette survives save
and reload. Live lights tint nearby model surfaces with their Home Assistant brightness and colour.
Rotating the camera does not swap which lights illuminate the scene. When many lights are on,
additional fixtures illuminate several nearby surfaces with simpler glows to keep shadow-rendering
cost bounded. Every active light also has a luminous source core. Up to twelve lights use detailed
shadows; performance mode retains two. Brightness and colour changes reuse existing shadows.

For downlights and ground spike spots, placement editing includes **Spotlight direction**. Choose
**Aim in 3D view**, point at a surface and click to set the beam direction. The preview arrow does not
move the equipment. Yaw/pitch fields provide the same operation on phones and for keyboard users.
**Reset direction** restores the fixture default; normal Save/Cancel and Undo apply.

Placement also accepts door frames, door leaves and other visible model objects. Click the actual
face to attach with a **Free / other surface** mount. The height and X/Y/Z fields allow fine
adjustment; editing Y now updates the mounting height too. Model scans and equipment markers are
not attachment surfaces.

Daylight controls live under Rendering: Live time follows the model location; Studio keeps a steady
architectural light; date/time and morning/noon/night shortcuts preview another time. The time zone
is shown beside the input. Location/north overrides are view-only and disclose model north certainty.
Soft shadows can be switched to crisp shadows. Performance mode reduces the site shadow map.
Expanded sensor labels use font-independent SVG icons, including a complete thermometer for
temperature, with their text readings retained for screen readers.

Global illumination intensity in Rendering → Daylight and shadows (phone: Lighting)
scales sunlight, moonlit fill and ambient/studio light from 0–300%, with 100% as the
default. It is a view-only override independent of time; equipment light brightness
is unchanged. PNG captures use the adjusted illumination.

Equipment placement's **Shown as** picker offers household appliances, plumbing, sauna heaters,
network/media equipment and lamp variants. Wall/floor/ceiling spots expose **Spotlight direction**:
enter yaw/pitch or use **Aim in 3D view** on desktop. Aiming points from the actual fixture head.
Choose **Solar panel** to reveal width, length, thickness and tilt fields. Click a visible roof to
align its slope, then adjust position/rotation numerically as needed. Panel dimensions are metres;
other equipment silhouettes are compact symbols. Every panel remains a separate equipment placement.

Home Assistant import rows keep their selection, device details and import action in aligned columns.
**Hide already imported** filters linked devices from the registry list. Selected-device entity choices
show explicit Disabled, Hidden and availability badges, so diagnostic readings remain distinguishable
from entities HA cannot currently provide. Dropdowns with explanatory hints open wider than a compact
trigger when space allows, and remain constrained to the phone viewport.

Additional symbols cover Wi-Fi access points, robot vacuums, indoor/outdoor heat pumps, HomePods,
network switches, security cameras, fans and humidifiers. Linked climate entities show HVAC activity
and current temperature in the compact label; expansion shows available target temperatures and fan
mode. Unknown/unavailable values remain unavailable.

Vertical and horizontal LED bars have a saved **LED bar length (m)** (0.05–20 m, default 1 m).
Their cross-section stays fixed and total light output scales with length at the same HA brightness.
Lighting uses a bounded, illustrative point source at the bar's centre, not a photometric strip model.
Motion sensors and security cameras expose saved yaw/pitch and **Detection / viewing range (m)**
(0.1–30 m, default 5 m). Selecting one shows an illustrative 60° cone. Regular sensors have no
aiming controls or cone, even if an older placement stored aim settings. The cone does not
configure HA detection coverage.
**Show equipment** in Layers (or below the phone viewer) hides markers, equipment labels, lights and
selection cones together. Cones are excluded from PNG downloads and do not keep an idle viewer rendering.

**Hide occluded equipment** in Layers (also below the phone viewer) hides equipment labels and
click targets behind visible floors, walls, doors and other model surfaces. Turn it on when viewing
upstairs to stop downstairs sensors showing through the floor. It follows the camera, hidden layers,
wall cuts and exploded floors; selected equipment obeys the same occlusion. Turn it off to see
through the model again. Like the other layer switches, this is a session-only view preference.

The discreet counter in the viewer's bottom-right corner measures actual rendered FPS during
sustained motion and shows **idle** when the demand-rendered scene settles. It does not force the
viewer to render. Hidden floors now also hide their 3D equipment models; disabling occlusion only
allows seeing equipment through visible geometry, not equipment on floors deliberately hidden.
