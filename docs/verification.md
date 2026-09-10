# Verification

Living record of what is checked automatically, what was measured, and what remains unverified.
Update the tables when results change; never record a number that was not measured.

## Automated
| Area | Where | Status |
|---|---|---|
| Migrations apply cleanly; schema snapshot; invariants (partial unique indexes, CHECKs, FKs) | `tests/integration/migrations.test.ts`, `schema-invariants.test.ts` | pending |
| Recurrence (completion-anchored vs fixed calendar vs seasonal), month ends, DST 2027-03-28 / 2027-10-31 | `tests/unit/domain/*` | pending |
| Occurrence lifecycle, weekly reminders, restart catch-up, digest | `tests/unit/domain/*` | pending |
| Completion + stock atomicity, idempotency, concurrency, void/correction, kit explode, replacement | `tests/unit/domain/*` | pending |
| Notification action validation and replay | `tests/unit/domain/*` | pending |
| Low battery: hysteresis, invalid/stale values, recovery ≠ maintenance | `tests/unit/domain/*`, `tests/unit/ha/*` | pending |
| HA socket: auth, reconnect, resubscribe, heartbeat, registry re-list | `tests/unit/ha/*` | pending |
| Model manifest validation, colour-plan isolation, visibility/explode policy, geometry | `tests/unit/house/*` | pending |
| Auth boundary: 401/redirect, expired/revoked, sign-up blocked, rate limit, open redirect | `tests/unit/auth/*` | pending |
| Browser, auth boundary: sign-in, private attachment, model API closed, session revocation, password change, deep link, open redirect, health | `tests/e2e/auth.spec.ts` (both projects, one invocation) | **16 passed, 0 failed** — 8 per project (2026-09-08) |
| Files: safeJoin, sniffing, EXIF stripping, upload cap | `tests/unit/files/*` | pending |
| Backup/restore round trip | `tests/integration/backup-restore.test.ts` | pending |
| Browser, fixture package: load integrity, selection + URL sync, click picking, colour isolation, visibility, views, explode, on-demand rendering, asset auth/ETag, mount→unmount→mount disposal | `tests/e2e/house.spec.ts` (`--project=desktop`) | **14 passed, 1 skipped, 1 fixme, 0 failed** of 16 (2026-09-08) |
| Browser, real package: load timing, 401-of-403-surface colours, living-room datum pick, shared-wall independence, dormer isolation, exploded structure edges, orbit frame times | `tests/e2e/house-real.spec.ts` (`--project=desktop`, `VH_REAL_MODEL_DIR` set) | **7 passed, 0 skipped, 1 fixme, 0 failed** of 8 (2026-09-08) |
| Browser screenshots (§13.4 list) | `tests/e2e/screenshots.spec.ts` (both projects, one invocation) | **desktop 9 passed / 14 skipped, phone 1 passed / 22 skipped, 0 failed** of 23 per project; 16 captures in `test-results/screenshots/` (2026-09-08) |

The two non-passing entries in `house.spec.ts` and the one in `house-real.spec.ts` are deliberate
and carry their reasons in the test bodies:

- `entering edit mode zeroes the gap and the save payload is physical` — `test.skip`. The e2e
  bootstrap seeds no equipment, so there is no placement to edit and `lastSavePayload()` can never
  be non-null. Needs a change to `tests/e2e/start-server.ts` (seed one equipment asset; the
  revision registration the fixture harness lacks is already solved for the real spec, see below).
- `the plan view looks straight down at the active floor` — `test.fixme`, app bug 1/2 below.
- `a saved colour comes back on the next page load` — `test.fixme`, app bug 3 below.

Both `test.fixme` markers (which between them document the three app bugs below) were re-verified on
2026-09-08 by temporarily turning them back into `test` and running them: the plan-view assertion
reports polar **63.83°** where it needs < 1°, and the colour test shows the inspector's colour input
holding the saved `#ff00ff` while `materialHex` reports the manifest default `#d9c3a5`. The markers
were then restored.

Screenshot entries 9, 12–17, 21, 23, 25 and 26–28 of §13.4 are skipped individually, each naming
what it needs (a garage or structure asset the fixture does not have; a placement; a stored route; a
Home Assistant connection; a seeded task). Captured, in `test-results/screenshots/`: §13.4 **1, 2,
3, 4, 5, 6, 7, 8, 10, 11, 18, 19, 20, 22** on desktop and **24** on phone, plus a second phone view
of the same scene with a floor isolated (`24b-phone-house-floor-isolated.png` — numbered `24b`
because it is not §13.4 #25).

**Model revisions in the e2e harness.** `tests/e2e/start-server.ts` calls `installPackage` but not
`registerRevision`, so on the plain fixture harness nothing that needs a `model_revision` persists
(colours, placements, routes). `house-real.spec.ts` therefore installs the real package through the
household's own `pnpm vh-admin model-import`, which runs `validatePackageDir` → `installPackage` →
`registerRevision` (`scripts/vh-admin.ts:264-277`) against the harness's throwaway data directory —
which is what makes the colour-persistence bug reproducible there and nowhere else.

## Measured (MacBook Pro M5 Pro, macOS 27, 2026-09-08; Mac mini still to be measured)

> Numbers below come from headless Chromium (Playwright) against the production build served by
> `next start`, and from `ps -o rss=` sampling of the real processes. They are development-machine
> figures; the Mac mini must be measured after deployment with `scripts/measure-resources.sh`.

| Metric | Target | Measured | Notes |
|---|---|---|---|
| First useful maintenance screen (TTFB, authenticated, production) | < 1 s | /today 13 ms, /supplies 6 ms, /history 11 ms, /equipment 6 ms, /house 5–33 ms | server time on loopback; add LAN + browser render |
| Interactive simplified model (real package, 7 default assets) | < 3 s | interactive = ready at 0.71 s after navigation start | hook installed at 0.44 s; 350 draw calls, 11 578 triangles, 2 shader programs |
| Selection feedback (pointer-up → first `invalidate()`) | < 100 ms | 5.6 ms (inspector heading updated at 144 ms) | |
| Orbit frame time, scripted 2 s orbit | ≤ 16.7 ms p95 | avg 20.8 ms, p95 21.8 ms (104 frames) | headless SwiftShader-class GPU path; re-measure on real GPU |
| Idle rendering (2 s, SSE open) | 0 extra frames | 0 `invalidate()` calls, 0 frames | |
| Model asset bytes served (default set) | — | 410 kB + 204 kB + 94 kB + 710 kB … (immutable, ETag 304 on revisit) | |
| Web RSS (`next-server`) after warm-up, light repeated loads | measured → alert 1.5× p95 | p50 221 MB, p95 225 MB (n=8) → provisional alert 340 MB | `pnpm exec` launcher would add ~126 MB; launchd wrapper execs node directly |
| Worker RSS (HA disabled, ticks + drain + metrics) | measured → alert 1.5× p95 | p50 108 MB, p95 108 MB steady; start-up spike 321 MB (heap 176 MB) in the first minute | provisional alert 165 MB; investigate the start-up spike (integrity/metrics jobs) |

Browser suites (production build, headless Chromium, 2026-09-08): `house.spec.ts` 14 passed / 1 skipped
(needs a seeded equipment record) / 0 failed; `house-real.spec.ts` (real package, run separately) 8 passed
incl. colour persistence across reload; `auth.spec.ts` 16/16 with both projects in one invocation;
`screenshots.spec.ts` 16 PNGs.

**`auth.spec.ts` across two projects, and why `workers: 1` is not negotiable.** Until 2026-09-08 a
single invocation of both projects failed `changing the password retires the old one` on `phone`
(and, the file being `mode: "serial"`, skipped the rest of that project). The cause was in the
suite, not the app: `fixtures.ts`'s `nextClientIp()` counted up from a fixed prefix, and Playwright
runs each project in its own worker process, so `phone` restarted the counter and handed out the
addresses `desktop` had just used. Better Auth keys its rate limits by address **plus** path and
allows 3 `/change-password` calls per 10 s, so the two projects' four calls shared one bucket and
the test's restore step was answered 429 ("Too many attempts, wait a minute."). Client addresses are
random per context now — the same thing the house helper already did — and both projects pass in one
invocation. Running the same file with `--workers=2` still fails, by design and not because of the
addresses: the projects then run in parallel against one harness database and one pair of seeded
users, so `desktop`'s "sign out others" revokes the `phone` session that is mid-test (measured
2026-09-08: `signing out other devices …` fails on `phone`, with both projects' user agents listed
under one account). That is what `workers: 1` in `playwright.config.ts` exists to prevent.

## Not verified / limitations
- Live Home Assistant delivery to phones and physical equipment control require `HA_TOKEN` on the server; tests use the fake HA server and never send commands to production devices.
- Deployment on the Mac mini: scripts are tested locally; the first real install happens with the owner.
- **Frame times above are a regression tripwire, not an acceptance result.** They come from a
  software rasteriser (SwiftShader) in headless Chromium, where the orbit p95 of 22.2 ms says more
  about the rasteriser than about the viewer. The acceptance numbers have to come from a manual run
  in a real browser on the target Mac mini — **that run has not happened yet**.
- **Frame-rate figures cannot be read from a hidden preview pane.** The browser stops servicing
  `requestAnimationFrame` for a page that is not visible, so an in-app preview pane that is hidden
  (or a background tab) pauses the render loop entirely — the rAF sampler in
  `src/house/test/testHook.ts` simply stops being called. `frameStats()` then reports whatever it
  sampled before the pane went away, and an idle-frame or orbit measurement taken there is
  meaningless. Every number in this file was measured in a **foreground** headless page driven by
  Playwright; never quote a frame time read from a hidden pane.
- Equipment placement, infrastructure routes and the Home Assistant marker layer are unverified in a
  browser: the e2e bootstrap seeds no equipment and registers no model revision, so nothing in those
  layers has data to render. See the skips listed above.
- **§13.2 checks with no browser test yet**: #20 (search → `Enter` on the first result sets the
  floor, the equipment selection, the camera target and the `aria-live` announcement — needs a
  seeded HA-linked placement), #26's heap half (`disposedInfo()` is asserted across
  mount→unmount→mount, but "JS heap within 10 % of the first cycle" is not — headless Chromium
  needs `--js-flags=--expose-gc` for a trustworthy reading), and #27 (a dev-StrictMode double-mount
  run — the suite only ever exercises a production `next start` build).
- `test-results/` is Playwright's `outputDir` and is cleared at the start of every run, so the
  screenshots and `house-measurements.json` normally belong to whichever spec ran last. To keep both
  (as the 2026-09-08 set does), run the real-model spec first and then the screenshots with
  `--output=test-results/pw-artifacts`, which moves Playwright's own wipe to that subdirectory and
  leaves the two artefacts alone.

## 2026-09-09 — placement, viewer panels and PNG export

- Shared mount policy: synthetic soffit and roomless exterior wall fixtures, endpoint save/reload,
  invalid surface rejection, picked-side and numeric standoff preservation.
- Elevation: room floor, terrain, sloping terrain and explicit datum fallback; browser hover leaves
  the draft unchanged and clears on exit.
- Panels: compact View/Layers/Rendering tabs, collapse/cancel/reopen, pending-save dismissal guard,
  original route restoration and exploded-state restoration.
- PNG: desktop and phone download, nonblank model, visible labels, opaque theme/solid/gradient
  backgrounds, guide cleanup and no continued idle rendering. Export images and panel screenshots
  were visually inspected using the synthetic model.
- `pnpm check`: 95 files passed; 1,365 tests passed, 23 existing skips. Local socket access is required
  for the fake HA servers.
- Playwright (`house`, `house-theme`, `house-viewer`): 37 passed, 21 skipped (desktop-only cases on
  phones and existing camera limitations). The build and synthetic data were isolated in a temporary
  checkout so verification did not overwrite the live production build.

## 2026-09-10 — scene scale, adaptive daylight and furnishings

- `pnpm check`: 118 files passed; 1,578 tests passed, 23 existing skips. Coverage includes physical
  equipment envelopes and source offsets, framing large fixtures, daylight freshness/fallbacks,
  furnishings geometry, authenticated persistence and the additive migration.
- Isolated Chromium regressions passed for 72 detailed lights and All mode with 80 installed lights,
  batched/single-pass image comparison, cached shadow reuse, state transitions, camera movement,
  PNG capture and idle rendering. The 80-light path also passed on the phone viewport.
- Outdoor lux/weather controls passed live updates, unavailable fallback, deterministic Studio mode
  and restoring saved registry identities before opening Rendering. Spotlight aiming and adjacent
  room wall occlusion regressions also passed.
- Desktop and phone furnishings flows cover preview dimensions, save/reload, cancellation, layer
  visibility, deletion and returning to idle. All browser fixtures are synthetic. Headless software
  shader compilation needs a longer warm-up than the user's hardware; these checks establish
  correctness, not a hardware-independent frame-rate guarantee.
- The browser harness refuses to build in the running macOS production checkout. Run it from a
  separate checkout as documented in `tests/e2e/README.md`.

## 2026-09-10 — viewer controls, trees and interactive furniture

- Rendering preferences have validated browser persistence and reset coverage, including All installed
  lights. Desktop/phone reload checks pass. Outdoor lux discovery covers HA metadata present only in
  cached state attributes, live discovery, unavailable fallback and source restoration.
- Tree geometry, physical height, framing, clipping and authenticated save/reload are covered by
  synthetic unit/API fixtures and desktop/phone placement regressions. Migration 0012 adds one column.
- Floating floor/wall modes, door hiding/restoration, compact rendering categories, keyboard access,
  collapse/cancel guards, PNG capture and phone controls have targeted coverage. A stable rendering
  tray height prevents setting changes from resizing the canvas.
- Furniture catalog miniatures use the actual procedural geometry without extra WebGL contexts.
  Desktop/phone catalog, resize, save/reload, cancellation, visibility and deletion checks pass.
  Pointer checks cover hover without draft mutation, click placement, clicking a saved object to edit,
  repositioning and rejection of wall collisions, including hidden walls in physical collision tests.
- Lighting regressions pass for 80 shadowed lights, cache reuse, PNG export and idle rendering, plus
  batched/single-pass image comparison. Software-GPU warm-up allows 45 seconds both for the initial
  budget and the additional All-light batches. Browser fixtures remain isolated from production.
- `pnpm check`: 121 test files passed; 1,597 tests passed and 23 existing tests skipped.

## 2026-09-10 — object placement, picking and additional models

- `pnpm check`: 124 files passed; 1,614 tests passed and 23 existing skips. Synthetic coverage
  includes visible/clipped furniture raycasts, support-face picking, 45-degree yaw, wall collision,
  instance bounds after moving equipment, source wall-cap clipping and floor/roof invariants.
- Desktop browser regressions pass for hidden upstairs furniture not intercepting a lower-floor
  click; furniture grid placement, fixed-anchor rotation, collision rejection and draft isolation;
  dryer placement on a washing machine and on a cabinet, saved free-mount height, and body rotation.
  Existing arbitrary model-surface attachment and numeric adjustments also pass.
- Floor focus, closed view, ordered wall modes, camera navigation and Select-only surface hover/click
  pass browser checks. Tests account for room labels becoming clickable in Select mode.
- Desktop and phone tests pass for equipment and furniture edits, configurable tree/panel dimensions,
  new wood-storage dimension save/reload, cancellation and furniture layer visibility. Screenshots
  were reviewed for the compact floating controls and phone model display.
- Migration 0013 adds equipment dimensions and extends the furnishing-kind CHECK. Its furnishing
  rebuild is safe because that table has no inbound foreign keys; a regression seeds a furnishing
  before 0013 and verifies the existing record survives. Production model inspection was read-only;
  no household geometry or identifiers were added to fixtures.

## 2026-09-10 — object attachments and multi-floor infrastructure

- `pnpm check`: 127 files passed; 1,639 tests passed and 23 existing skips.
- Synthetic tests cover malformed wall caps in every wall mode, retained legitimate caps, and
  removal of only the invalid cap's baked edge segments. Read-only model inspection confirmed the
  reported artifact is suppressed; the source package and private geometry remain outside the repo.
- Collision tests cover fridge/freezer overlap, a remote resting on the fridge door, penetration
  rejection, stacking, open space under tables, and nonblocking rug/floor-heating underlays.
- Property-tree tests cover floor sections, cross-floor route membership, furniture selection and
  keyboard-focus recovery after moving or deleting an item. Tank geometry has a rectangular case.
- Route tests cover provisional hover without draft mutation, point-kind preservation, per-point
  floor/room metadata, and a real API save/read/resave round trip preserving the final riser endpoint.
- The isolated production-build browser suite passes seven desktop/phone cases (five desktop-only
  cases skipped on phones): furniture CRUD and pointer placement, object stacking and fridge-door
  attachment with save/reload, arbitrary model-face attachment, property sections, and multi-floor
  route preview/save/reload plus independent Pipes/Ducts visibility.
- Screenshot review found and fixed a shrinking phone furniture form. A layout regression now
  checks that the following details section cannot overlap the form; desktop/phone CRUD reruns pass.
